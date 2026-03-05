# Setup & Running Guide

## Prerequisites

- **Node.js 18+** and npm
- **Supabase project** — free tier works for development, pro recommended for continuous tracking
- **API keys** (optional but recommended):
  - [Groq](https://console.groq.com/) — AI explanations (free tier)
  - [NewsAPI](https://newsapi.org/) — news scoring (free: 100 req/day)
  - [Jupiter](https://portal.jup.ag/) — Jupiter prediction market ingestion (free tier: 1 RPS)

## 1. Clone & Install

```bash
git clone https://github.com/your-org/market-move-intelligence.git
cd market-move-intelligence
npm install
```

This installs all workspaces (services + frontend) in one go.

## 2. Set Up Supabase

Create a project at [supabase.com](https://supabase.com). Then run the SQL migrations in order via the Supabase SQL Editor:

1. **Core tables** — these are created automatically by the ingestion service on first write, but you need:
   ```sql
   -- sql/tracked_slugs.sql
   -- Creates the tracked_slugs config table
   ```
2. **News + resolution tables**:
   ```sql
   -- sql/news_cache.sql
   -- Creates news_cache, market_resolution tables and adds news_score column
   ```

Run both files from the `sql/` directory in the Supabase SQL Editor.

The remaining tables (`trades`, `market_mid_ticks`, `market_aggregates`, `market_movements`, `movement_events`, `signal_scores`, `movement_explanations`, `market_dominant_outcomes`) are created by Supabase if you configure them, or the service will insert into them directly.

## 3. Configure Environment

### Ingestion service

Create `services/ingestion/.env`:

```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Optional — enables AI explanations
GROQ_API_KEY=gsk_...

# Optional — enables news scoring
NEWSAPI_KEY=your-newsapi-key

# Optional — Polymarket API credentials (for authenticated endpoints)
POLY_API_KEY=
POLY_API_SECRET=
POLY_API_PASSPHRASE=

# Optional — Jupiter prediction market ingestion
JUP_API_KEY=your-jupiter-api-key
```

### Storage service

Create `services/storage/.env`:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Frontend

Create `apps/web/.env.local`:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Optional — pre-load a specific market slug on page load
NEXT_PUBLIC_TRACKED_SLUG=
```

## 4. Run

You need at least two processes: the Polymarket ingestion backend and the frontend. Jupiter ingestion is optional and runs as a third process.

### Start ingestion

```bash
npx tsx services/ingestion/src/index.ts
```

On startup it will:
1. Connect to Polymarket's Activity WebSocket (trades)
2. Sync tracked slugs from Supabase (every 30s)
3. Hydrate market metadata and spin up CLOB WebSocket connections (order-book)
4. Backfill recent trades from Polymarket's data API
5. Begin detecting movements and scoring signals

You should see logs like:
```
[ws] connected to Polymarket activity feed
[slug-sync] 1 active slug(s), 0 new
[hydrate] government-shutdown → 2 child market(s)
[clob] connecting batch 1/1 (2 assets)
[backfill] fetched 47 trades for government-shutdown
```

### Start frontend

```bash
npm --workspace @market-move-intelligence/web run dev
```

Opens at **http://localhost:3005**. Paste a Polymarket event slug into the UI. The ingestion service picks it up within 30 seconds.

### Start Jupiter ingestion (optional, separate process)

```bash
npm --workspace @market-move-intelligence/ingestion run jup:ingest
```

Polls Jupiter's prediction market API for trades and orderbooks. By default it only tracks `jup:`-prefixed entries from `tracked_slugs`. Set `JUP_AUTO_DISCOVER=1` to also auto-discover live/trending markets (high volume — not recommended on free tier). Requires `JUP_API_KEY`.

You should see logs like:
```
[jup] Jupiter Prediction Market ingestion starting...
[jup-markets] discovered 24 open markets across 18 events
[jup] tracking 24 markets
[jup-poller] trade polling every 5000ms
[jup-poller] +orderbook ... (20 markets, full cycle ~30.0s)
```

### All processes at once

```bash
# Terminal 1 — Polymarket ingestion
npx tsx services/ingestion/src/index.ts

# Terminal 2 — Jupiter ingestion (optional)

npm --workspace @market-move-intelligence/ingestion run jup:ingest
# Terminal 3 — Frontend
npm run dev
```

## 5. Track a Market

### Polymarket
1. Go to [polymarket.com](https://polymarket.com) and find a market
2. Copy the event slug from the URL (e.g., `presidential-election-winner-2024`)
3. Paste it into the frontend's slug input
4. The ingestion service syncs the slug within 30s and starts streaming data
5. Movements and signals appear on the chart as they're detected

### Jupiter
Jupiter markets are tracked via `jup:`-prefixed slugs in `tracked_slugs`. You can also set `JUP_AUTO_DISCOVER=1` to auto-discover all live/trending markets (not recommended on free tier). To manually track a specific Jupiter market or event, insert it with the `jup:` prefix:

```sql
INSERT INTO tracked_slugs (slug) VALUES ('jup:MARKET_ID_HERE');
```

### Direct SQL
You can also insert Polymarket slugs directly:
```sql
INSERT INTO tracked_slugs (slug) VALUES ('your-polymarket-slug');
```

## 6. Common Environment Overrides

Most defaults work out of the box. Override these if you need to tune behavior:

| Variable | Default | What it does |
|----------|---------|--------------|
| `MAX_CLOB_ASSETS` | `20` | Assets per CLOB WebSocket connection |
| `TRADE_BUFFER_MAX` | `200` | Flush trade buffer at N trades |
| `TRADE_BUFFER_FLUSH_MS` | `1000` | Flush trade buffer every N ms |
| `SLUG_SYNC_MS` | `30000` | How often to poll tracked_slugs |
| `BACKFILL_LOOKBACK_MS` | `300000` | How far back to backfill on startup (5 min) |
| `FINALIZE_POLL_MS` | `30000` | How often to check pending movements for finalization |

### Movement detection thresholds

| Variable | Default | Description |
|----------|---------|-------------|
| `MOVEMENT_5M_PRICE_THRESHOLD` | `0.03` | 5-minute window price trigger |
| `MOVEMENT_15M_PRICE_THRESHOLD` | `0.04` | 15-minute window |
| `MOVEMENT_1H_PRICE_THRESHOLD` | `0.06` | 1-hour window |
| `MOVEMENT_4H_PRICE_THRESHOLD` | `0.08` | 4-hour window |
| `MOVEMENT_5M_THIN_THRESHOLD` | `0.05` | Elevated threshold for thin-liquidity markets (5m) |

Full list of env vars and defaults are documented inline in the source files — see `detectMovement.ts` and `detectMovementRealtime.ts`.

## 7. Troubleshooting

**No trades appearing**
- Check that your Supabase URL and service role key are correct in both `.env` files
- Verify the market slug is active on Polymarket (resolved markets are auto-skipped)
- Look for `[ws]` connection logs — if missing, check your network/firewall

**CLOB WebSocket disconnecting frequently**
- Lower `MAX_CLOB_ASSETS` (default 20). Higher values increase the chance of rate limiting
- Check logs for `[clob] rate-limited` messages

**No signals/movements detected**
- The market needs enough trading activity to cross thresholds
- Low-volume markets may never trigger. Try a high-volume market first
- Check `market_movements` table in Supabase to see if any rows exist

**AI explanations not appearing**
- Ensure `GROQ_API_KEY` is set in `services/ingestion/.env`
- The system falls back to template explanations if the AI call fails or times out

**Frontend shows empty chart**
- Ensure the ingestion service is running and has data for the slug
- Check browser console for SSE connection errors
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set in `apps/web/.env.local`

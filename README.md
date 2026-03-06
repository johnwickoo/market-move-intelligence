# Market Move Intelligence

Real-time prediction market movement detection, classification, and explanation engine. Ingests trades and orderbook data from Polymarket via WebSocket, detects significant price movements across multiple time windows using a compound tracking system, classifies them by signal type, generates AI-powered explanations, and attests signals on Solana.

## Architecture

```
Polymarket CLOB WS
     (trades + book)
          |
     [ ingestion ]  ── trades + mid-ticks ──> [ storage (Supabase) ]
          |
     [ movements ]  ── compound detect ──> market_movements (OPEN)
          |
     [ finalize ]   ── recompute settled metrics ──> market_movements (FINAL)
          |
     [ signals ]    ── classify + score
          |
     ┌────┴────┐
[ explain ]  [ chain ]
AI text      Solana attestation
     |
[ web ]  ◀── SSE ◀── Supabase
```

| Service | Path | Role |
|---|---|---|
| **ingestion** | `services/ingestion/` | WebSocket connection to Polymarket CLOB, trade + orderbook processing, mid-tick generation |
| **storage** | `services/storage/` | Supabase client, trade/tick insertion, dedup |
| **movements** | `services/movements/` | Compound movement detection, finalization worker, event-level detection |
| **signals** | `services/signals/` | Signal scoring and classification (price, velocity, capital, info, time, news, crypto correlation) |
| **explanations** | `services/explanations/` | AI-generated movement explanations |
| **news** | `services/news/` | Entity-aware news fetching and relevance scoring |
| **crypto** | `services/crypto/` | Spot price context (BTC/ETH via CoinGecko) for crypto-correlated markets |
| **chain** | `services/chain/` | Solana on-chain signal attestation (devnet) |
| **aggregates** | `services/aggregates/` | Rolling market aggregate stats (volume, first seen) |
| **web** | `apps/web/` | Next.js dashboard with live chart and SSE streaming |

## Detection

### Compound Movement Detector (`detectMovement.ts`)

Runs on each trade. Evaluates four time windows, fires on the smallest triggering window, then graduates upward as momentum continues:

| Window | Price Threshold | Thin Threshold | Finalize Delay |
|---|---|---|---|
| 5m | 3% | 5% | 5 min |
| 15m | 4% | 7% | 10 min |
| 1h | 6% | 10% | 30 min |
| 4h | 8% | 12% | 2 hours |

Plus an **event** window (since last signal) for detecting cumulative moves across signal boundaries.

**Compound tracker** per market+outcome:

1. **Fire** on the smallest triggering window (price drift, volume ratio, or velocity)
2. **Extend** on each subsequent trade (updates end_price, pushes finalize timer)
3. **Graduate** to the next larger window when momentum persists past half the next window's duration
4. Uses a **pre-move anchor price** (5min before window start) for accurate drift calculation

Trigger criteria: price threshold (drift + absolute move), volume ratio (vs 7-day baseline), or velocity (`|drift| / sqrt(minutes)`). Markets with wide spreads, few trades, or few price levels are flagged as thin liquidity with elevated thresholds.

### Finalization (`finalizeMovements.ts`)

Poll-based worker that processes OPEN movements via two paths:

1. **Timer-expired**: `finalize_at` has passed (5m-2h delay depending on window type)
2. **Early finalize**: price has stabilized before timer expires, with guards:
   - Window must not have been recently extended (2min freshness check)
   - At least 60% of the finalize delay must have elapsed
   - Large moves (>15% drift) require longer stabilization (4min, 6+ ticks)

On finalization:
1. Recomputes metrics from settled tick/trade data (queries descending to handle Supabase row limits)
2. Runs signal classification (`scoreSignals`)
3. Generates AI explanation (`buildExplanation`)
4. Attests signal on Solana (`attestSignal`)

## Signal Scoring (`scoreSignals.ts`)

Each movement is scored on multiple dimensions (0-1 scale), then classified by priority:

1. **LIQUIDITY** -- thin book, don't trust the move
2. **NEWS** -- driven by correlated news coverage
3. **VELOCITY** -- rapid impulse (drift/sqrt(time) >= 0.008)
4. **CAPITAL** -- large money flows (volume ratio >= 2x)
5. **INFO** -- price moved without capital (information-driven)
6. **TIME** -- approaching market resolution

Additional scoring factors:
- **Crypto correlation**: compares prediction market drift to underlying spot price (BTC/ETH) to detect tracking vs divergence
- **Recency multiplier**: 5m signals get full weight (1.0), 4h signals ~45%
- **Liquidity penalty**: up to 35% confidence reduction for thin markets
- **Minimum confidence**: signals below 0.25 are dropped

## Running

### Prerequisites

- Node.js 18+
- Supabase project

### Environment

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=sk-...                           # AI explanations
SOLANA_RPC_URL=https://api.devnet.solana.com    # on-chain attestation
SOLANA_PRIVATE_KEY=...                          # attestation wallet
```

### Start

```bash
npm install

# Polymarket ingestion (includes finalize worker)
npx ts-node services/ingestion/src/index.ts

# Frontend
npm run dev
```

### Scripts

| Script | Purpose |
|---|---|
| `scripts/seed-markets.ts` | Seed initial market data |
| `scripts/monitor.ts` | Live monitoring dashboard |
| `scripts/stream-diag.ts` | WebSocket stream diagnostics |
| `scripts/midtick-diag.ts` | Mid-tick data diagnostics |
| `scripts/backfill.ts` | Backfill historical data |

## Configuration

All thresholds are tunable via env vars:

- `MOVEMENT_{5M,15M,1H,4H}_PRICE_THRESHOLD` -- price trigger per window
- `MOVEMENT_{5M,15M,1H,4H}_THIN_THRESHOLD` -- elevated threshold for thin markets
- `MOVEMENT_{5M,15M,1H,4H}_VOLUME_THRESHOLD` -- volume ratio trigger
- `MOVEMENT_{5M,15M,1H,4H}_COOLDOWN_MS` -- anti-spam cooldown per window
- `MOVEMENT_VELOCITY_THRESHOLD` -- velocity trigger (default: 0.008)
- `MOVEMENT_ANCHOR_LOOKBACK_MS` -- pre-move anchor lookback (default: 5min)
- `FINALIZE_POLL_MS` -- finalize worker poll interval (default: 30s)
- `SIGNAL_MIN_CONFIDENCE` -- minimum confidence to emit (default: 0.25)
- `MAX_CLOB_ASSETS` -- assets per CLOB WebSocket connection (default: 20)

## Known Constraints

- **Supabase PGRST_MAX_ROWS**: Defaults to 1000. All critical queries order descending to prioritize the most recent data when results are truncated.
- **MIN_PRICE_FOR_ALERT**: Markets below 5 cents are excluded from detection to avoid noise from near-zero resolution moves.
- **Outcome filtering**: Multi-outcome markets (Yes/No) must filter ticks and trades by outcome to avoid mixing complementary prices.

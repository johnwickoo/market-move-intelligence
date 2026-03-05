# Technical Documentation

## Overview

Market Move Intelligence is a real-time signal detection system for prediction markets. It ingests trade and order-book data from Polymarket and Jupiter, detects price movements across multiple time windows, classifies them by likely driver, and surfaces annotated signals on a live chart.

## Table of Contents

- [System Architecture](#system-architecture)
- [Data Flow](#data-flow)
- [Services](#services)
- [Database Schema](#database-schema)
- [Movement Detection](#movement-detection)
- [Signal Scoring](#signal-scoring)
- [Frontend](#frontend)
- [API Reference](#api-reference)
- [Configuration Reference](#configuration-reference)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Data Sources                                 │
│  Polymarket Activity WS ──── trades (buy/sell events)               │
│  Polymarket CLOB WS ──────── order-book snapshots (bid/ask/mid)     │
│  Polymarket Data API ──────── historical trade backfill             │
│  Jupiter Prediction API ───── trades + orderbook (REST polling)     │
│  NewsAPI.org ──────────────── news article coverage                 │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                              ▼
┌───────────────────────────────┐  ┌───────────────────────────────┐
│   Polymarket Ingestion        │  │   Jupiter Ingestion            │
│   (WebSocket — real-time)     │  │   (REST polling — 5s trades,   │
│                               │  │    1.5s/market orderbook)      │
│   Trade normalization         │  │                               │
│   → dedup → batch insert      │  │   Same pipeline: dedup →      │
│   CLOB mid-price extraction   │  │   batch insert → aggregate    │
│   → spread filter → mid-tick  │  │   → detect → score            │
│   Market metadata hydration   │  │                               │
│   Slug sync (30s)             │  │   Auto-discover live/trending │
│   Backfill on startup         │  │   markets or track jup: slugs │
└───────────────────────────────┘  └───────────────────────────────┘
                    │                              │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              ┌──────────┐  ┌──────────┐  ┌──────────────┐
              │  Trades   │  │ Mid Ticks│  │  Aggregates  │
              │  (raw)    │  │ (1s res) │  │  (OHLCV)     │
              └─────┬─────┘  └──────────┘  └──────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Movement Detection                               │
│  Multi-Window Detector (DB) ─── 5m / 15m / 1h / 4h windows         │
│  Realtime Detector (memory) ─── breakout + EMA crossover            │
│  Event-Level Detector ────────── cross-outcome correlation          │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Signal Pipeline                                   │
│  Score 6 dimensions → classify → finalize → explain (AI/template)   │
│  Optional: Solana attestation (memo or program mode)                │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Frontend (Next.js 15)                             │
│  REST API ── chart series, movements, explanations                  │
│  SSE stream ── real-time signal push                                │
│  lightweight-charts ── price chart with signal annotation bands     │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Trade Lifecycle

1. **Ingest** — Polymarket Activity WebSocket delivers raw trade JSON
2. **Normalize** — Extract `market_id`, `price`, `size`, `side`, `outcome`, `timestamp`
3. **Deduplicate** — In-memory map with TTL (default 10 min) rejects duplicate trade IDs
4. **Buffer** — Trades accumulate in a buffer (max 200 or 1s timer, whichever hits first)
5. **Insert** — Batch upsert into `trades` table with retry + exponential backoff
6. **Aggregate** — `updateAggregateBuffered()` updates OHLCV in `market_aggregates`
7. **Detect** — `detectMovement()` evaluates all four time windows against the new trade
8. **Score** — If a movement is detected, `scoreSignals()` runs the six-dimension classifier
9. **Explain** — Two-stage finalize: classify once momentum settles, then generate AI explanation
10. **Stream** — Frontend receives the signal via SSE and renders it on the chart

### Mid-Tick Lifecycle

1. **Ingest** — CLOB WebSocket delivers order-book snapshots per asset
2. **Extract** — Compute mid-price from best bid/ask, reject if spread > 30%
3. **Insert** — Upsert into `market_mid_ticks` (time-series) and `market_mid_latest` (latest value)
4. **Chart** — Frontend queries mid-ticks for the price line on the chart

### Failure Handling

- **Supabase down** — After 3 failed inserts in 60s, trades spool to disk (`/tmp/mmi-trade-spool.ndjson`). A replay loop retries every 30s.
- **WebSocket disconnect** — Exponential backoff reconnection (base 500ms, max varies by connection type). CLOB connections use a `destroyed` flag to prevent ghost reconnections.
- **AI timeout** — Falls back to template-based explanations. 8s timeout default.

---

## Services

### `services/ingestion`

The main orchestrator. Two separate entry points — one for Polymarket (WebSocket), one for Jupiter (REST polling). Both feed into the same Supabase tables and detection pipeline.

#### Polymarket Adapter (`src/index.ts`)

Connects to Polymarket WebSockets, manages market lifecycle, and drives the detection pipeline.

**Key files:**
| File | Purpose |
|------|---------|
| `index.ts` | Entry point — WS connections, slug sync, trade buffer, detection loop |
| `polymarket.clob.ws.ts` | CLOB WebSocket client with reconnection and `ClobHandle` lifecycle |
| `polymarket.activity.ws.ts` | Activity feed WebSocket for raw trades |
| `backfill.ts` | Historical trade backfill from Polymarket Data API |

**Resilience patterns:**
- Trade dedup via `Map<tradeId, timestamp>` with TTL eviction
- Buffered batch inserts (configurable size + timer)
- Spool-to-disk on sustained Supabase failures
- Movement gating: min 10s + min 0.01 price change between detection calls
- Market resolution detection with 30-min grace period (auto-unsubscribe resolved markets)

#### Jupiter Adapter (`src/jupiter/index.ts`)

REST-based poller for Jupiter's prediction market API (`api.jup.ag/prediction/v1`). Jupiter doesn't expose WebSockets, so this adapter polls trades every 5s and round-robins orderbook requests across tracked markets with a 1.5s gap (respecting the free-tier 1 RPS limit).

**Key files:**
| File | Purpose |
|------|---------|
| `jupiter/index.ts` | Entry point — poller setup, trade buffer, detection loop |
| `jupiter/jupiter.poller.ts` | Sequential request queue with rate limiting. Trade polling + orderbook round-robin |
| `jupiter/jupiter.api.ts` | REST client — `/trades`, `/orderbook/{id}`, `/events`, `/markets/{id}` |
| `jupiter/jupiter.transform.ts` | `jupiterTradeToInsert()` and `jupiterOrderbookToMidTick()` — normalizes to shared types |
| `jupiter/jupiter.markets.ts` | Market discovery (live + trending events) and `jup:` slug sync from `tracked_slugs` |
| `jupiter/jupiter.types.ts` | Type definitions for Jupiter API responses |

**How it works:**
1. **Market discovery** — fetches live + trending events from Jupiter, or reads `jup:`-prefixed entries from `tracked_slugs`
2. **Trade polling** — polls `/trades` every 5s, tracks `lastSeenTradeId` cursor to skip old trades
3. **Orderbook polling** — round-robins `/orderbook/{marketId}` for the top N markets by 24h volume (default 20), one request every 1.5s
4. **Normalization** — Jupiter prices are in micro-USD or cents; the transform layer converts to 0–1 decimal and maps `buy/sell` + `yes/no` to the shared `TradeInsert` schema
5. **Pipeline** — same as Polymarket: dedup → buffer → batch insert → aggregate → detect → score

**Namespacing:** All Jupiter IDs are prefixed with `jup:` to avoid collisions with Polymarket data in the same tables.

**Run separately:** `npm --workspace @market-move-intelligence/ingestion run jup:ingest`

### `services/movements`

Two independent detectors that run in parallel.

**`detectMovement.ts`** — Multi-window detector (DB-backed)
- Single DB fetch (4h lookback) evaluates four windows per call
- Deterministic movement IDs prevent duplicates: `{marketId}:{window}:{bucketStart}`
- Liquidity guard elevates thresholds for thin markets (wide spread, few trades, few price levels)
- Event-anchored: re-anchors start price to the previous movement's end price

**`detectMovementRealtime.ts`** — In-memory detector
- Zero DB queries — pure state machine on live mid-prices
- Breakout detection: price breaks 60-min high/low by 3%+
- EMA crossover: 1-min EMA crosses 5-min EMA with 3-tick confirmation
- Requires price stability (3 ticks or 5s at same level) and a recent trade (within 60s)

**`detectMovementEvent.ts`** — Event-level detector
- Fires when multiple child outcomes in an event reprice simultaneously
- Requires min 2 child markets, min 3 trades per bucket, min $500 volume

### `services/signals`

Classifies movements by likely driver using six scoring dimensions.

**`scoreSignals.ts`** — Main scoring entry point
- Fetches trade data, aggregates, and news for the movement's time window
- Computes six dimension scores (0–1), then classifies by priority order
- Confidence is penalized by liquidity risk (up to 35%) and boosted by recency

**`fetchRelevantNews.ts`** — News integration
- Uses AI to generate search keywords from the market title
- Queries NewsAPI.org and scores article relevance
- Caches results by slug + hour bucket

### `services/explanations`

Generates human-readable explanations for detected movements.

**`explainMovement.ts`** — Two-stage finalization
- Stage 1: Classify the movement (runs when momentum settles)
- Stage 2: Generate AI explanation via Groq Llama 3.3 70B
- Falls back to template-based explanations on AI failure

### `services/news`

**`newsapi.client.ts`** — Slug/title resolution from trade data for news queries.

### `services/storage`

**`db.ts`** — Supabase client singleton and `insertTradeBatch()` helper.
**`insertMidTick.ts`** — Mid-tick upsert with dedup logic.
**`types.ts`** — Shared `TradeInsert` type definition.

### `services/aggregates`

**`updateAggregate.ts`** — Buffered OHLCV aggregation. Flushes on timer (5s default) or trade count (50 default).

### `services/chain`

**`attestSignal.ts`** — Solana on-chain attestation via Jupiter. Supports memo mode (simple tx memo) and program mode (custom program instruction).

---

## Database Schema

### Core Tables

| Table | Primary Key | Description |
|-------|-------------|-------------|
| `trades` | `id` | Raw trade events. `id` format: `txHash:assetId` |
| `market_mid_ticks` | `(market_id, timestamp)` | Mid-price time series from CLOB order-book |
| `market_aggregates` | `(market_id, bucket)` | OHLCV candle data |
| `market_dominant_outcomes` | `market_id` | Tracks which outcome is currently dominant |

### Detection Tables

| Table | Primary Key | Description |
|-------|-------------|-------------|
| `market_movements` | `id` | Detected price movements. ID format: `{marketId}:{window}:{bucketStart}` |
| `movement_events` | `id` | Event-level movements (cross-outcome) |
| `signal_scores` | `movement_id` | Six-dimension scores + classification + confidence |
| `movement_explanations` | `movement_id` | AI-generated or template explanations |

### Configuration Tables

| Table | Primary Key | Description |
|-------|-------------|-------------|
| `tracked_slugs` | `slug` | Which market slugs to track. Synced every 30s |
| `market_resolution` | `market_id` | Resolution timing and status per market |
| `news_cache` | `(slug, hour_bucket)` | Cached NewsAPI responses |

### Key Relationships

```
tracked_slugs.slug
    │
    ├── trades.market_id (via ingestion)
    ├── market_mid_ticks.market_id
    ├── market_aggregates.market_id
    │
    └── market_movements.market_id
            │
            ├── signal_scores.movement_id
            └── movement_explanations.movement_id
```

---

## Movement Detection

### Multi-Window Thresholds

| Window | Price Threshold | Thin Threshold | Min Absolute | Volume Ratio | Cooldown |
|--------|----------------|----------------|--------------|--------------|----------|
| 5m     | 3%             | 5%             | 2%           | 2.0x         | 60s      |
| 15m    | 4%             | 7%             | 2%           | 2.0x         | 120s     |
| 1h     | 6%             | 10%            | 3%           | 2.0x         | 180s     |
| 4h     | 8%             | 12%            | 3%           | 2.0x         | 300s     |

### Liquidity Guard

A market is flagged as **thin liquidity** when any of these hold:
- Spread exceeds threshold (configurable per window)
- Trade count below minimum
- Fewer than minimum distinct price levels

Thin markets use the elevated threshold column, reducing false positives from noise.

### Velocity Metric

```
velocity = |Δprice| / √(minutes)
```

Normalizes speed across different time windows. A 3% move in 5 minutes is more significant than 3% in 4 hours. Used as a scoring dimension and as an additional gate for short windows.

### Movement ID Determinism

Each movement gets an ID: `{marketId}:{window}:{bucketStart}` where `bucketStart` is the start of the time bucket rounded to the window size. This means the same movement in the same window and bucket is silently deduplicated on insert.

---

## Signal Scoring

### Six Dimensions (0–1 scale)

| Dimension | What it measures | Key inputs |
|-----------|-----------------|------------|
| **Capital** | Money flow intensity | Total volume vs baseline, trade count, average size |
| **Price** | Magnitude of the move | Price delta, percentage change |
| **Velocity** | Speed of information | `\|Δprice\| / √(minutes)`, acceleration |
| **Info** | Information asymmetry | Price moved without proportional volume (few trades, many price levels) |
| **Liquidity** | Market structure risk | Spread width, trade count, price level count |
| **Time** | Resolution proximity | Hours until market end date (72h horizon) |

### Classification Priority

Signals are classified top-down — the first match wins:

1. **LIQUIDITY** — thin book, movement may not be trustworthy
2. **NEWS** — high news coverage score from NewsAPI
3. **VELOCITY** — rapid impulse (high velocity score)
4. **CAPITAL** — large money flows (high capital score)
5. **INFO** — price moved without volume (high info score)
6. **TIME** — approaching market resolution

### Confidence Adjustments

- **Liquidity penalty**: up to 35% reduction for thin markets
- **Recency weighting**: 5m signals get full weight, 4h signals ~72%
- **Minimum threshold**: signals below 25% confidence are dropped

---

## Frontend

### Tech Stack

- **Next.js 15** with App Router
- **lightweight-charts v4** for price charting
- **Server-Sent Events** for real-time signal streaming

### Pages & Routes

| Route | Purpose |
|-------|---------|
| `/` | Main page — chart, signal bands, outcome filters |

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/markets` | GET | Returns chart series data, movements, and explanations for tracked markets |
| `/api/stream` | GET | SSE endpoint — pushes new signals and price updates in real-time |
| `/api/track` | POST | Add/remove slugs from tracking |

### Chart Features

- Multi-outcome lines (one per child market, color-coded)
- Signal annotation bands in swim-lane layout (non-overlapping)
- Outcome filter pills to show/hide specific outcomes
- Signal pill with count, last-signal time, and pulse animation on new signals

---

## Configuration Reference

### Required Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `SUPABASE_URL` | ingestion, storage, frontend | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ingestion, storage, frontend | Supabase service role key |

### Optional — Feature Enablement

| Variable | Where | Description |
|----------|-------|-------------|
| `GROQ_API_KEY` | ingestion | Enables AI-generated explanations (Groq Llama 3.3 70B) |
| `NEWSAPI_KEY` | ingestion | Enables news coverage scoring |
| `SOLANA_ATTESTATION_ENABLED` | ingestion | Set `true` to enable on-chain attestation |
| `SOLANA_RPC_URL` | chain | Solana RPC endpoint for attestation |
| `SOLANA_PRIVATE_KEY` | chain | Wallet key for attestation transactions |

### Ingestion Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CLOB_ASSETS` | `20` | Assets per CLOB WebSocket connection |
| `TRADE_BUFFER_MAX` | `200` | Flush trade buffer at N trades |
| `TRADE_BUFFER_FLUSH_MS` | `1000` | Flush trade buffer interval (ms) |
| `TRADE_DEDUPE_TTL_MS` | `600000` | Trade dedup window (10 min) |
| `SLUG_SYNC_MS` | `30000` | Tracked slugs poll interval (ms) |
| `BACKFILL_LOOKBACK_MS` | `300000` | How far back to backfill on startup (5 min) |
| `BACKFILL_INTERVAL_MS` | `60000` | Periodic backfill check interval |
| `WS_STALE_MS` | `60000` | WebSocket stale timeout |
| `RESOLUTION_GRACE_MS` | `1800000` | Grace period after market resolution (30 min) |

### Movement Detection Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `MOVEMENT_{5M,15M,1H,4H}_PRICE_THRESHOLD` | 0.03–0.08 | Price trigger per window |
| `MOVEMENT_{5M,15M,1H,4H}_THIN_THRESHOLD` | 0.05–0.12 | Elevated threshold for thin markets |
| `MOVEMENT_{5M,15M,1H,4H}_MIN_ABS` | 0.02–0.03 | Minimum absolute price change |
| `MOVEMENT_{5M,15M,1H,4H}_VOLUME_THRESHOLD` | 2.0 | Volume ratio trigger |
| `MOVEMENT_{5M,15M,1H,4H}_COOLDOWN_MS` | 60s–300s | Per-window cooldown |
| `MOVEMENT_VELOCITY_THRESHOLD` | `0.008` | Minimum velocity to consider |
| `MOVEMENT_GLOBAL_COOLDOWN_MS` | `180000` | Global cooldown across all windows |

### Realtime Detection Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `MOVEMENT_RT_MIN_MS` | `2000` | Minimum time between detections |
| `MOVEMENT_RT_MIN_STEP` | `0.01` | Minimum price step |
| `MOVEMENT_RT_EMA_CONFIRM_TICKS` | `3` | Ticks to confirm EMA crossover |
| `MOVEMENT_RT_PERSIST_TICKS` | `3` | Ticks at stable price before firing |
| `MOVEMENT_RT_PERSIST_MS` | `5000` | Time at stable price before firing |
| `MOVEMENT_RT_TRADE_CONFIRM_MS` | `60000` | Recent trade required within this window |
| `FINALIZE_POLL_MS` | `30000` | How often to check pending movements |

### Jupiter Ingestion Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `JUP_API_KEY` | — | Jupiter API key (get at portal.jup.ag) |
| `JUP_PREDICTION_API_URL` | `https://api.jup.ag/prediction/v1` | Jupiter prediction API base URL |
| `JUP_AUTO_DISCOVER` | `0` | Set to `1` to auto-discover live/trending markets (high volume) |
| `JUP_TRADE_POLL_MS` | `5000` | Trade polling interval |
| `JUP_MIN_REQUEST_GAP_MS` | `1500` | Min gap between any two API requests (rate limit) |
| `JUP_MAX_ORDERBOOK_MARKETS` | `20` | Max markets to poll orderbooks for (top N by volume) |
| `JUP_TRADE_BUFFER_MAX` | `100` | Flush trade buffer at N trades |
| `JUP_TRADE_BUFFER_FLUSH_MS` | `1000` | Flush trade buffer interval |
| `JUP_TRADE_DEDUPE_TTL_MS` | `600000` | Trade dedup window (10 min) |
| `JUP_SLUG_SYNC_MS` | `30000` | Tracked slugs poll interval |
| `JUP_DISCOVER_INTERVAL_MS` | `300000` | Market discovery cache TTL (5 min) |

### Aggregate Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `AGGREGATE_FLUSH_MS` | `5000` | OHLCV flush interval |
| `AGGREGATE_MAX_TRADES` | `50` | Flush after N trades |

### Debugging Flags

Set any of these to `"1"` to enable verbose logging:

| Variable | What it logs |
|----------|-------------|
| `LOG_MID_DEBUG` | Mid-price calculation details |
| `LOG_CLOB_RAW` | Raw CLOB WebSocket messages |
| `LOG_RETRY` | Retry attempts on failed inserts |
| `LOG_TRADE_DEBUG` | Individual trade processing |
| `LOG_MID` | Mid-price updates |

---

## Project Structure

```
market-move-intelligence/
├── apps/
│   └── web/                    # Next.js 15 frontend
│       └── src/
│           ├── app/            # App Router pages + API routes
│           ├── components/     # MovementCard, MarketList, SignalBand
│           ├── hooks/          # useMarketStream (SSE hook)
│           └── lib/            # API client, Supabase client, types
├── services/
│   ├── ingestion/              # Main orchestrator — WS, backfill, detection loop
│   ├── movements/              # Multi-window + realtime + event detectors
│   ├── signals/                # Six-dimension scoring + classification
│   ├── explanations/           # AI explanations via Groq
│   ├── news/                   # NewsAPI integration
│   ├── storage/                # Supabase client + helpers
│   ├── aggregates/             # OHLCV aggregation
│   └── chain/                  # Solana attestation
├── sql/                        # Database migrations
├── GUIDE.md                    # Setup and running instructions
├── MILESTONES.md               # Project roadmap
└── README.md                   # Project overview
```

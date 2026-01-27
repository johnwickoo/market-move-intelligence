# Market Move Intelligence — Full API/Logic Doc (Simplified but Detailed)

This document describes every module and function currently in the codebase, how data flows through the system, and what each part is responsible for. It also points you to internal materials to read for deeper context.

> Note: Many modules are stubs (TODOs). They are documented as design placeholders.

---

## 1) System Overview (What Runs)

### Ingestion (services/ingestion)
- **Purpose**: Pulls trades and orderbook updates from Polymarket, normalizes them, writes to Supabase, and triggers movement detection.
- **Data written**:
  - `trades` (raw trades)
  - `market_mid_ticks` (history, throttled)
  - `market_mid_latest` (latest state per asset)
  - `market_aggregates` (rolling aggregates, throttled)
  - `market_movements` (24h detector)
  - `movement_events` (realtime detector)
  - `signal_scores` (movement classification)

### Movements (services/movements)
- **detectMovement**: 24h DB-backed detector (slow but authoritative).
- **detectMovementRealtime**: in-memory detector (fast alerts).

### Aggregates (services/aggregates)
- **updateAggregateBuffered**: throttled roll-up of trades into `market_aggregates`.

### Signals (services/signals)
- **scoreSignals**: classifies movements into CAPITAL/INFO/LIQUIDITY/TIME.

### Storage (services/storage)
- **Supabase client** and insert helpers.
- **insertMidTick**: inserts history + upserts latest.

### Web App (apps/web)
- Basic Next.js placeholder UI.

---

## 2) Data Flow (High Level)

1. **Trades WS**
   - Polymarket activity feed (trades) → `toTradeInsert` → `insertTrade`
   - Trade updates → `updateAggregateBuffered`
   - Trade updates → `detectMovement` (Yes-only gating, min time/step)

2. **CLOB WS**
   - Polymarket CLOB top-of-book → `toSyntheticMid`
   - Throttled tick writes → `insertMidTick`
   - Real-time movement detector fed with mid price

3. **Movement classification**
   - `detectMovement` inserts `market_movements`
   - `scoreSignals` inserts `signal_scores`

---

## 3) Ingestion Service (services/ingestion)

### services/ingestion/src/index.ts
**Constants**
- `MARKET_ID`, `YES_ASSET`, `NO_ASSET`: hardcoded Polymarket market/asset IDs.
- `MID_BUCKET_MS`: bucket size for mid-history throttling (2s).
- `MOVEMENT_MIN_MS`, `MOVEMENT_MIN_STEP`: gating for expensive 24h detector.

**State**
- `lastTopByAsset`: remembers last rounded best bid/ask per asset for history writes.
- `latestSignalByAsset`: latest canonical price (mid fallback) for movement gating.
- `lastMovementGate`: last 24h detector trigger per market.

**Functions**
- `roundPx(n, decimals=3)`
  - Rounds prices (used to detect meaningful top-of-book changes).

- `shouldStoreMid(assetId, bestBid, bestAsk, nowMs)`
  - Throttles history writes: write on rounded bid/ask change or new 2s bucket.

- `toTradeInsert(msg)`
  - Parses Polymarket activity payload to `TradeInsert`.
  - Computes timestamp from `msg.timestamp` (ms) or payload (s).
  - Returns null if required fields missing.

- `bestBidFromBids(bids)`
  - Scans bids array for highest numeric price.

- `bestAskFromAsks(asks)`
  - Scans asks array for lowest numeric price.

- `toSyntheticMid(msg)`
  - Extracts best bid/ask from top-of-book.
  - Computes:
    - `mid` (bid/ask average or one-sided fallback)
    - `spread`, `spreadPct`
  - Filters out invalid or absurd spread.
  - Updates `latestSignalByAsset` with canonical mid.

**Trade WS path**
- `connectPolymarketWS` → parse trades → insert → aggregate → detectMovement.
- Gating:
  - only `Yes` outcome to avoid mirror alerts
  - minimum time and min price step

**CLOB WS path**
- `connectClobMarketWS` → parse book → compute mid
- Feed realtime detector (`movementRealtime`) with mid price for Yes.
- Write history ticks via `insertMidTick` (throttled).

### services/ingestion/src/polymarket.ws.ts
- `connectPolymarketWS(opts)`
  - Connects to Polymarket WS.
  - Sends subscription payloads.
  - Keeps connection alive with `ping`.
  - Parses JSON and forwards to `opts.onMessage`.

### services/ingestion/src/polymarket.clob.ws.ts
- `connectClobMarketWS(opts)`
  - Connects to CLOB WS.
  - Subscribes to market channel with asset IDs.
  - Handles `ping/pong`.
  - Exponential backoff on rate limiting.
  - Throttles rapid reconnect loops.

### services/ingestion/src/getApiKey.ts
- Uses `@polymarket/clob-client` to derive an API key from a wallet.

### services/ingestion/src/snapshot.poll.ts
- TODO stub (polling-based ingestion).

### services/ingestion/src/types.ts
- `IngestionConfig` placeholder.

---

## 4) Storage Service (services/storage)

### services/storage/src/db.ts
- `supabase`
  - Supabase client created from `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- `dbInsert(table, values)`
  - Generic insert helper.
- `insertTrade(trade)`
  - Inserts into `trades`.

### services/storage/src/insertMidTick.ts
- Types:
  - `MidTickInsert`
  - `LastTick` (for dedupe)
- `sameNum(a,b,eps)`
  - Float compare with epsilon.
- `isSameTick(a,b)`
  - Compares best_bid/best_ask/mid/spread/spread_pct.
- `insertMidTick(row)`
  - In-memory dedupe (skip if identical top-of-book).
  - Insert into `market_mid_ticks` (history).
  - Upsert into `market_mid_latest` on `(market_id, asset_id)` (current state).

### services/storage/src/types.ts
- `TradeInsert` shape for trades.

### services/storage/src/schema.sql
- Defines schema for:
  - `markets`
  - `trades`
  - `price_snapshots`
  - `movement_events` (includes `asset_id`, `outcome`)
  - `signal_scores`
  - `news_events`
  - `evaluation_metrics`

---

## 5) Aggregates (services/aggregates)

### services/aggregates/src/updateAggregate.ts
**Purpose**
Maintain `market_aggregates` as a rolling 30-day window (no subtraction yet).

**Key functions**
- `toNum(x)`
  - Parses numeric values and throws if invalid.
- `applyAggregateDelta(marketId, delta)`
  - Loads existing aggregate row.
  - Inserts if missing, else updates counts/volumes/avg/min/max/last price.
- `updateAggregate(trade)`
  - Direct (non-buffered) single-trade update.
- `updateAggregateBuffered(trade)`
  - Buffers trades by market.
  - Flush triggers:
    - `AGGREGATE_MAX_TRADES` (default 50)
    - `AGGREGATE_FLUSH_MS` (default 5000)
  - Dynamic timer adjusts flush speed based on last 5 flush counts.
  - Logs `[agg] flush ...` with reason.

**Dynamic tuning (env)**
- `AGGREGATE_FLUSH_MS` (default 5000)
- `AGGREGATE_MAX_TRADES` (default 50)
- `AGGREGATE_MIN_FLUSH_MS` (default 1000)
- `AGGREGATE_MAX_FLUSH_MS` (default 20000)

---

## 6) Movements (services/movements)

### services/movements/src/detectMovement.ts (24h DB-backed)
**Purpose**
Detects price/volume movements over last 24h using DB reads.

**Workflow**
1. **Trades**:
   - Query `trades` over 24h.
   - Compute volume, avg trade size, price levels.
2. **Mid ticks**:
   - Query `market_mid_ticks` over 24h.
   - Compute start/end/min/max mid, drift %, range %.
   - Compute avg spread %.
3. **Aggregates**:
   - Query `market_aggregates` for baseline daily volume.
4. **Liquidity guard**:
   - Thin if spread high or too few trades/levels.
5. **Thresholds**:
   - PRICE hit: mid drift/range over threshold.
   - VOLUME hit: daily or hourly spikes.
6. **Insert**:
   - Insert into `market_movements` once per hour bucket.
   - Call `scoreSignals`.

### services/movements/src/detectMovementRealtime.ts (in-memory)
**Purpose**
Fast alerting based on mid updates, no heavy DB queries.

**State per asset**
- `lastPrice`, `lastTs`
- `emaFast`, `emaSlow`
- 60x 1-minute OHLC buckets (last hour)
- `lastEventTs` map for cooldowns

**Gates**
- `MOVEMENT_RT_MIN_MS` (default 2000ms)
- `MOVEMENT_RT_MIN_STEP` (default 0.01)
- `MOVEMENT_RT_EVENT_COOLDOWN_MS` (default 60s)
- `MOVEMENT_RT_EVICT_MS` (default 30m idle eviction)

**Triggers**
- Breakout: price >= 3% above 1h max or below 1h min.
- EMA cross:
  - Fast EMA (30s) vs Slow EMA (120s).

**Output**
- Inserts into `movement_events` with `reason`.
- Logs `[movement-rt]`.

---

## 7) Signals (services/signals)

### services/signals/src/scoreSignals.ts
**Purpose**
Classifies movements and computes confidence.

**Inputs**
- Movement fields (price drift/range, volume ratios, trade counts, liquidity).

**Scores**
- `capitalScore`: volume-based (daily + hourly).
- `priceScore`: drift + range vs 15% baseline threshold.
- `liquidityRisk`: thin book / sparse trades.
- `infoScore`: price moved without capital.
- `timeScore`: placeholder (0.2).

**Classification**
- LIQUIDITY if liquidityRisk high.
- CAPITAL if capitalScore >= 0.6.
- INFO if infoScore or priceScore high.
- TIME fallback if timeScore is higher than confidence.

**Output**
- Inserts into `signal_scores`.

### services/signals/src/* (stubs)
- `capital.signal.ts`, `info.signal.ts`, `time.signal.ts`, `index.ts`, `signal.types.ts`
  - Placeholders for future logic.

---

## 8) Detector / Scoring / News / Scheduler (stubs)

### services/detector
- `movement.detector.ts`: placeholder.
- `movement.rules.ts`: placeholder.
- `types.ts`: placeholder.

### services/scoring
- `classifier.ts`, `confidence.ts`, `types.ts`: placeholders.

### services/news
- `newsapi.client.ts`, `keyword.builder.ts`, `types.ts`: placeholders.

### services/scheduler
- `cron.ts`, `types.ts`: placeholders.

---

## 9) Web App (apps/web)

### Components
- `MovementCard`: placeholder component.
- `MarketList`: renders `MovementCard`.
  
### App
- `page.tsx`: renders header + MarketList.
- `layout.tsx`: HTML scaffold + metadata.

### API Types (stubs)
- `apps/web/src/lib/types.ts`
- `apps/web/src/lib/api.ts`

---

## 10) Environment Variables (Observed)

In use:
- `POLYMARKET_WS_URL` (ingestion trades WS)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (storage)
- `PRIVATE_KEY` (getApiKey helper)
- Movement/aggregate tunables:
  - `AGGREGATE_FLUSH_MS`
  - `AGGREGATE_MAX_TRADES`
  - `AGGREGATE_MIN_FLUSH_MS`
  - `AGGREGATE_MAX_FLUSH_MS`
  - `MOVEMENT_MIN_MS`
  - `MOVEMENT_MIN_STEP`
  - `MOVEMENT_RT_MIN_MS`
  - `MOVEMENT_RT_MIN_STEP`
  - `MOVEMENT_RT_EVENT_COOLDOWN_MS`
  - `MOVEMENT_RT_EVICT_MS`

---

## 11) Materials to Read (Internal)

Use these files as the canonical sources of truth:
- `services/ingestion/src/index.ts` (core data flow)
- `services/movements/src/detectMovement.ts` (24h detector)
- `services/movements/src/detectMovementRealtime.ts` (realtime detector)
- `services/aggregates/src/updateAggregate.ts` (aggregation logic)
- `services/signals/src/scoreSignals.ts` (classification)
- `services/storage/src/insertMidTick.ts` (history + latest storage)
- `services/storage/src/schema.sql` (tables)

If you want, I can also generate per-table data dictionaries and a data lineage diagram.

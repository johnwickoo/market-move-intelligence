# Market Move Intelligence

Real-time detection and classification of price movements on Polymarket prediction markets. The system ingests live trade and order-book data, detects significant price and volume movements across two complementary time horizons, scores each movement by likely driver, and surfaces annotated signals on a live chart.

## Architecture Overview

```
Polymarket WebSocket (trades)  ──┐
                                 ├──▶  Ingestion Service  ──▶  Supabase (PostgreSQL)
Polymarket WebSocket (CLOB)   ──┘        │                         │
                                         │                         │
                              ┌──────────┴──────────┐              │
                              ▼                     ▼              │
                     24h Movement Detector   Realtime Detector     │
                              │                     │              │
                              ▼                     ▼              │
                        Signal Scorer         movement_events      │
                              │                                    │
                              ▼                                    │
                     Explanation Builder                            │
                              │                                    │
                              ▼                                    │
                     market_movements ◀────────────────────────────┘
                     signal_scores                                 │
                     movement_explanations                         │
                                                                   │
                     Next.js Frontend  ◀── SSE stream ◀────────────┘
```

### Services

| Directory | Purpose |
|---|---|
| `services/ingestion` | Connects to Polymarket WebSockets, normalizes trades and order-book ticks, stores to Supabase, gates detection calls |
| `services/movements` | Two detectors: `detectMovement` (24h, DB-backed) and `MovementRealtime` (60min, in-memory) |
| `services/signals` | Scores movements into CAPITAL / INFO / LIQUIDITY / TIME classifications |
| `services/explanations` | Generates human-readable summaries of detected movements |
| `services/storage` | Supabase client and DB insert helpers |
| `apps/web` | Next.js 15 frontend with live chart, SSE streaming, slug management |

---

## Detection System

The system runs two complementary detectors in parallel. Each is optimized for a different latency/accuracy trade-off.

### 1. 24-Hour Movement Detector

**File:** `services/movements/src/detectMovement.ts`

Runs on every qualifying trade. Queries the database for a rolling 24-hour window of trades and mid-price ticks, computes price drift, price range, and volume ratios against historical baselines, then emits a `market_movements` row when thresholds are breached.

#### Data Collection

The detector gathers four categories of data per invocation:

**Trades (24h window):**
- Queries the `trades` table for the target market + outcome
- Computes `volume24h`, `avgTradeSize24h`, `tradesCount`
- Counts `uniquePriceLevels` (distinct trade prices rounded to 2 decimals)

**Mid-Price Ticks (24h window):**
- Queries `market_mid_ticks` (order-book mid prices, not trade prints)
- Computes `startMid`, `endMid`, `minMid`, `maxMid`
- Derives `midDriftPct` = (end - start) / start (sustained directional move)
- Derives `midRangePct` = (max - min) / min (intraday spike/whipsaw)
- Computes `avgSpreadPct` (average bid-ask spread)

**Baseline Volume:**
- Loads `market_aggregates` for total historical volume and `first_seen_at`
- Calculates `baselineDaily` = total_volume / observed_days (capped at 30 days)
- Calculates `baselineHourly` = baselineDaily / 24
- Requires at least 7 days of history before volume comparisons are considered reliable

**Hourly Spikes:**
- Buckets trades into 24 hourly bins
- Finds peak hourly volume (`maxHourVol`)
- Computes `hourlyRatio` = maxHourVol / baselineHourly

#### Price Detection Logic

A price movement fires when ALL of these conditions are met:

1. **Has ticks:** At least 2 mid-price ticks exist in the window
2. **Price eligible:** The minimum mid-price >= 0.05 (filters out near-zero noise)
3. **Absolute move:** |max - min| >= 0.03 (3 cents minimum to avoid micro-noise)
4. **Threshold breach:** Either `midDriftPct` OR `midRangePct` exceeds the threshold:
   - Normal market: **8%** (`MOVEMENT_PRICE_THRESHOLD`)
   - Thin liquidity: **12%** (`MOVEMENT_THIN_PRICE_THRESHOLD`)

#### Volume Detection Logic

A volume movement fires when EITHER:

- `volumeRatio` (24h volume / baseline daily) >= **1.5x** (`MOVEMENT_VOLUME_THRESHOLD`)
- `hourlyRatio` (peak hour / baseline hourly) >= **1.5x**

Requires at least 3 days of observed history to avoid false positives on new markets.

#### Event-Anchored Detection (Shorter Timeframe)

When a previous movement exists for this market, the detector re-anchors its start price to the end price of the last movement. This creates an "event" window (shorter than 24h) that detects continued price movement since the last signal.

- `effectiveStartISO` = last movement's `window_end`
- `startMid` = last movement's `end_price`
- `midDriftPct` is recalculated from the anchor point
- `eventMinMid` / `eventMaxMid` are recalculated over the shorter window

This means the system can detect a series of staircase moves: the first triggers on the 24h window, subsequent moves trigger as "event" windows anchored to the last signal.

#### Price Confirmation

When price thresholds are breached but volume has NOT confirmed:

1. Look at the last N minutes of ticks (default: 10 minutes, `MOVEMENT_CONFIRM_MINUTES`)
2. Require at least M ticks in that window (default: 3, `MOVEMENT_CONFIRM_MIN_TICKS`)
3. For upward moves: confirm if the window's minimum price sustains >= 50% of threshold above start
4. For downward moves: confirm if the window's maximum price sustains >= 50% of threshold below start
5. Alternatively, confirm if absolute move >= 0.03

If confirmation fails, the price signal is suppressed. This prevents triggering on momentary spikes that immediately revert.

#### Liquidity Guard

The detector flags markets as "thin liquidity" when ANY of:

| Condition | Threshold |
|---|---|
| Average bid-ask spread | >= 5% |
| Trade count (24h) | < 15 |
| Unique price levels | < 8 |

When thin liquidity is detected:
- Price thresholds increase from 8% to 12% (requires larger moves to trigger)
- The `thin_liquidity` flag is stored on the movement row
- Signal scoring penalizes confidence (see Signal Scoring below)

#### Idempotency

Each movement gets a deterministic ID: `{marketId}:{outcome}:{windowType}:{hourBucket}`.

This limits output to **one movement per market+outcome per hour** per window type. The insert uses a duplicate-key check — if the ID already exists, the insert is silently skipped.

Additionally, a process-level cooldown gate prevents re-running the detector more than once per 60 seconds per market+outcome pair.

#### Output

On trigger, inserts a row into `market_movements` with all computed metrics, then calls `scoreSignals()` for classification and explanation generation.

---

### 2. Real-Time Detector (60-Minute Window)

**File:** `services/movements/src/detectMovementRealtime.ts`

An in-memory state machine that watches live mid-price updates and emits fast alerts without database queries. Optimized for low latency — detects breakouts and EMA crossovers within seconds.

#### State Management

Maintains per-asset state keyed by `{market_id}:{asset_id}`:

```
State per asset:
├── lastPrice, lastTs          # Most recent accepted price/time
├── emaFast (1min tau)         # Fast exponential moving average
├── emaSlow (5min tau)         # Slow exponential moving average
├── buckets[60]                # 60 x 1-minute OHLC candles
├── emaDir                     # Current EMA direction (-1 or 1)
├── emaPendingDir/Count        # Pending direction change confirmation
├── pendingPrice/Count/StartTs # Stability tracking
└── lastEventTs per reason     # Cooldown tracking
```

States are evicted after 30 minutes of inactivity (`EVICT_IDLE_MS`).

#### Input Gating

Updates are skipped when any of these conditions hold:

| Gate | Threshold | Purpose |
|---|---|---|
| Wide spread | > 10% (`MAX_SPREAD_PCT`) | Unreliable mid when spread is wide |
| Thin top-of-book | bid AND ask size < 5 (`MIN_TOP_SIZE`) | Don't trust prices with no depth |
| Time throttle | < 2s since last update (`MIN_UPDATE_MS`) | Prevent processing spam |
| Price step | change < 0.01 (`MIN_STEP`) | Ignore sub-penny noise |

#### Stability Confirmation

Before checking triggers, the detector confirms the price is "stable" — not just a momentary blip:

- If the price changes by >= 0.01 from `pendingPrice`: reset the pending state
- If the price is unchanged: increment `pendingCount`
- Stable when: `pendingCount >= 3` ticks OR `tsMs - pendingStartTs >= 5000ms`

Triggers only fire once stability is confirmed.

#### Trigger 1: Breakout Detection

Scans the last 60 minutes of 1-minute OHLC buckets to find the historical min and max:

```
Breakout UP:   current price >= historical max * 1.03  (3% above)
Breakout DOWN: current price <= historical min * 0.97  (3% below)
```

This detects when price breaks out of its recent 60-minute trading range by a meaningful margin.

#### Trigger 2: EMA Crossover

Maintains two exponential moving averages with different time constants:

| EMA | Time Constant | Responsiveness |
|---|---|---|
| Fast | 1 minute (`EMA_FAST_MS`) | Reacts quickly to price changes |
| Slow | 5 minutes (`EMA_SLOW_MS`) | Smooths out noise |

The EMA uses the standard exponential decay formula: `alpha = 1 - exp(-dt / tau)`.

Crossover detection:
1. Check that the slow EMA differs from current price by >= 0.3% (`EMA_MIN_PCT`)
2. Check that the gap between fast and slow EMAs is >= 0.5% (`EMA_GAP_PCT`)
3. Determine direction: fast > slow = bullish (1), fast < slow = bearish (-1)
4. If direction differs from current `emaDir`, start counting confirmation ticks
5. After 3 confirming ticks (`EMA_CONFIRM_TICKS`), emit the crossover event
6. Enforce 90-second cooldown per direction (`EMA_DIR_COOLDOWN_MS`)

#### Trade Confirmation

Events from mid-price updates (source: "mid") require a recent actual trade to have occurred within 60 seconds (`TRADE_CONFIRM_MS`). This prevents phantom signals from order-book changes that never result in fills.

The ingestion service calls `movementRealtime.onTrade()` on each trade to update the last-trade timestamp per asset.

#### Output

Emits one of four event types into the `movement_events` table:

| Reason | Meaning |
|---|---|
| `REALTIME_BREAKOUT_UP` | Price broke above 60-min high by 3%+ |
| `REALTIME_BREAKOUT_DOWN` | Price broke below 60-min low by 3%+ |
| `REALTIME_EMA_CROSS_UP` | Fast EMA crossed above slow EMA (bullish) |
| `REALTIME_EMA_CROSS_DOWN` | Fast EMA crossed below slow EMA (bearish) |

A 60-second cooldown (`EVENT_COOLDOWN_MS`) prevents duplicate events of the same type per asset.

---

## Signal Scoring

**File:** `services/signals/src/scoreSignals.ts`

After a 24h movement is detected, the scoring system classifies it into one of four categories and assigns a confidence score. This runs only for 24h/event movements (not real-time breakouts).

### Score Components

Each movement is evaluated on four dimensions, all normalized to 0..1:

#### Capital Score — "Did money show up?"

```
capitalScore = 0.6 * clamp(volumeRatio / 2.0) + 0.4 * clamp(hourlyRatio / 2.0)
```

- 2x daily volume = max capital score
- Weighted 60% daily, 40% hourly spike
- High capital score suggests institutional or whale activity

#### Price Score — "Did price meaningfully move?"

```
priceScore = 0.5 * clamp(drift / 0.15) + 0.5 * clamp(range / 0.15)
```

- 15% drift or range = max price score
- Drift captures sustained directional moves
- Range captures intraday spikes and whipsaws

#### Liquidity Risk — "Is this movement trustworthy?"

```
tradeRisk  = clamp((15 - tradesCount) / 15)
levelRisk  = clamp((8 - priceLevels) / 8)
thinRisk   = thin ? 1 : 0

liquidityRisk = 0.6 * thinRisk + 0.25 * tradeRisk + 0.15 * levelRisk
```

- Thin book flag dominates (60% weight)
- Trade count sparsity is secondary (25%)
- Price level diversity is tertiary (15%)

#### Info Score — "Price moved without capital behind it"

```
infoScore = priceScore * (1 - capitalScore) * (1 - clamp(volumeRatio / 2))
```

High info score means price moved significantly but volume was normal or low — suggesting the move was driven by new information, sentiment, or news rather than large capital flows.

#### Time Score

Computed from `market_resolution` using proximity to `resolved_at` / `end_time`.
Defaults to 0 when no resolution data exists.

### Classification

Evaluated in priority order (first match wins):

| Priority | Condition | Classification |
|---|---|---|
| 1 | `thin AND liquidityRisk >= 0.6` OR `liquidityRisk >= 0.75` | **LIQUIDITY** — Don't trust the move |
| 2 | `capitalScore >= 0.6` | **CAPITAL** — Large money flows |
| 3 | `infoScore >= 0.5 AND (tradesCount >= 50 OR priceLevels >= 8)` | **INFO** — Information/sentiment driven |
| 4 | `priceScore >= 0.6 AND thin` | **LIQUIDITY** — Price moved but book is thin |
| 5 | `priceScore >= 0.6 AND !thin` | **INFO** — Price moved, capital ambiguous |
| 6 | `timeScore > confidence` | **TIME** — Time dynamics |
| 7 | Fallback | **CAPITAL** — Default bucket |

### Confidence Adjustment

All signals receive a final liquidity penalty:

```
adjustedConfidence = confidence * (1 - 0.35 * liquidityRisk)
```

This means thin markets can reduce confidence by up to 35%, keeping the system conservative.

### Output

Inserts into `signal_scores`:
- `movement_id`, `capital_score`, `info_score`, `time_score`
- `classification` (CAPITAL | INFO | LIQUIDITY | TIME)
- `confidence` (0..1, adjusted for liquidity risk)

Then calls `buildExplanation()` and inserts the result into `movement_explanations`.

---

## Explanation Generation

**File:** `services/explanations/src/buildExplanation.ts`

Generates plain-English summaries by composing sentences:

1. **Price sentence:** "Price moved X% over Yh."
2. **Window sentence:** "This is the rolling 24h window." or "This is a recent move since the last signal."
3. **Volume sentence:** Based on volume ratio — below average, near typical, spiked above normal, or insufficient baseline
4. **Liquidity sentence:** "Orderbook appears thin, so price moves may be exaggerated." (if applicable)
5. **Classification sentence:** Maps classification to a human-readable driver explanation

---

## Ingestion Integration

**File:** `services/ingestion/src/index.ts`

The ingestion service orchestrates both detectors:

### Trade Flow

```
Polymarket trade WS message
  → Filter by tracked slug (eventSlugSet)
  → Normalize to TradeInsert
  → Deduplicate by trade ID
  → Record asset metadata + call movementRealtime.onTrade()
  → Buffer and flush to trades table
  → Update market_aggregates
  → Gate check:
      - Only dominant outcome (or "Yes" if unknown)
      - Min 10s between calls per market:outcome
      - Min 0.01 price step change
  → detectMovement(trade) → scoreSignals() → buildExplanation()
```

### Order-Book Flow

```
Polymarket CLOB WS message
  → Extract synthetic mid-price from best bid/ask
  → Filter for "Yes" outcome only
  → movementRealtime.onPriceUpdate()
      → EMA update → Bucket update → Stability check
      → checkBreakout() / checkEmaCross()
      → emitEvent() → movement_events table
  → Store mid-tick to market_mid_ticks (deduplicated)
```

### Dynamic Slug Management

Tracked slugs are stored in Supabase `tracked_slugs` table. The ingestion service polls this table every 30 seconds (`syncTrackedSlugs()`), merging new slugs into its active filter set without requiring a restart.

The frontend writes to this table via `/api/track` when a user loads a new slug.

---

## Database Schema

| Table | Purpose |
|---|---|
| `trades` | Individual trade records from Polymarket |
| `market_mid_ticks` | Time series of order-book mid prices per asset |
| `market_mid_latest` | Current best bid/ask/mid per asset |
| `market_aggregates` | Rolling total volume and first-seen timestamp per market |
| `market_dominant_outcomes` | Which outcome has the most recent activity per market |
| `market_movements` | Detected 24h and event-anchored movements with full metrics |
| `movement_events` | Real-time breakout and EMA crossover detections |
| `signal_scores` | Classification and confidence scores per movement |
| `movement_explanations` | Human-readable explanation text per movement |
| `tracked_slugs` | Slugs registered for tracking (shared between frontend and ingestion) |

---

## Configuration

All detection thresholds are configurable via environment variables:

### 24h Movement Detector

| Variable | Default | Description |
|---|---|---|
| `MOVEMENT_PRICE_THRESHOLD` | 0.08 | Min price drift/range to trigger (8%) |
| `MOVEMENT_THIN_PRICE_THRESHOLD` | 0.12 | Price threshold when liquidity is thin (12%) |
| `MOVEMENT_VOLUME_THRESHOLD` | 1.5 | Volume ratio multiplier to trigger (1.5x baseline) |
| `MOVEMENT_MIN_PRICE_FOR_ALERT` | 0.05 | Skip markets with mid below this level |
| `MOVEMENT_MIN_ABS_MOVE` | 0.03 | Minimum absolute price change (3 cents) |
| `MOVEMENT_CONFIRM_MINUTES` | 10 | Minutes to look back for price confirmation |
| `MOVEMENT_CONFIRM_MIN_TICKS` | 3 | Minimum ticks required for confirmation |

### Real-Time Detector

| Variable | Default | Description |
|---|---|---|
| `MOVEMENT_RT_MIN_MS` | 2000 | Min milliseconds between updates (throttle) |
| `MOVEMENT_RT_MIN_STEP` | 0.01 | Min price change to process |
| `MOVEMENT_RT_EVENT_COOLDOWN_MS` | 60000 | Cooldown between same-type events per asset |
| `MOVEMENT_RT_EVICT_MS` | 1800000 | Remove idle state after 30 minutes |
| `MOVEMENT_RT_MAX_SPREAD_PCT` | 0.1 | Max spread to accept updates (10%) |
| `MOVEMENT_RT_EMA_MIN_PCT` | 0.003 | Min EMA-to-price gap to evaluate (0.3%) |
| `MOVEMENT_RT_EMA_GAP_PCT` | 0.005 | Min fast-slow EMA gap to trigger (0.5%) |
| `MOVEMENT_RT_EMA_CONFIRM_TICKS` | 3 | Ticks to confirm EMA crossover |
| `MOVEMENT_RT_EMA_DIR_COOLDOWN_MS` | 90000 | Cooldown per EMA direction change (90s) |
| `MOVEMENT_RT_MIN_TOP_SIZE` | 5 | Min bid/ask size to trust |
| `MOVEMENT_RT_PERSIST_TICKS` | 3 | Ticks for stability confirmation |
| `MOVEMENT_RT_PERSIST_MS` | 5000 | Time for stability confirmation (5s) |
| `MOVEMENT_RT_TRADE_CONFIRM_MS` | 60000 | Max age of last trade for mid-source events |

### Signal Scoring

| Variable | Default | Description |
|---|---|---|
| `MIN_INFO_TRADES` | 50 | Min trades to allow INFO classification |
| `MIN_INFO_LEVELS` | 8 | Min price levels to allow INFO classification |
| `LIQUIDITY_OVERRIDE` | 0.6 | Liquidity risk threshold for thin+LIQUIDITY override |

---

## Running

### Prerequisites

- Node.js 18+
- Supabase project with the required tables (see `sql/` directory for migrations)
- Polymarket API access

### Environment Variables

```bash
# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Polymarket (ingestion service)
POLYMARKET_EVENT_SLUGS=your-event-slug          # Optional bootstrap; tracked_slugs table is preferred

# Frontend
NEXT_PUBLIC_TRACKED_SLUG=your-default-slug      # Optional default slug for the UI
```

### Start Services

```bash
# Install dependencies
npm install

# Run SQL migrations (in Supabase SQL editor)
# See sql/tracked_slugs.sql

# Start ingestion service
npx tsx services/ingestion/src/index.ts

# Start frontend (port 3005)
npm --workspace @market-move-intelligence/web run dev
```

### Frontend Usage

1. Navigate to `http://localhost:3005`
2. Enter a Polymarket event slug in the input field and click Load
3. The slug is registered in `tracked_slugs` and picked up by the ingestion service within 30 seconds
4. The chart populates with price data, volume bars, and movement annotations as data flows in

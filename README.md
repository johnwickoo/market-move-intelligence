# Market Move Intelligence

Real-time detection and classification of price movements on Polymarket prediction markets. The system ingests live trade and order-book data, detects significant price and volume movements across multiple time horizons using velocity-normalized thresholds, scores each movement by likely driver, and surfaces annotated signals on a live chart via SSE.

## Architecture Overview

```
Polymarket WebSocket (trades)  ──┐
                                 ├──▶  Ingestion Service  ──▶  Supabase (PostgreSQL)
Polymarket WebSocket (CLOB)   ──┘        │                         │
                                         │                         │
                              ┌──────────┴──────────┐              │
                              ▼                     ▼              │
                     Multi-Window Detector   Realtime Detector     │
                     (5m / 15m / 1h / 4h)   (60min in-memory)     │
                              │                     │              │
                              ▼                     ▼              │
                        Signal Scorer         movement_events      │
                     (velocity + recency)                          │
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
| `services/ingestion` | Connects to Polymarket WebSockets (trade + CLOB), normalizes data, stores to Supabase, gates detection calls |
| `services/movements` | Multi-window detector (`detectMovement` — 5m/15m/1h/4h, DB-backed) and `MovementRealtime` (60min, in-memory) |
| `services/signals` | Scores movements into CAPITAL / INFO / VELOCITY / LIQUIDITY / NEWS / TIME with recency weighting |
| `services/explanations` | Generates human-readable summaries of detected movements |
| `services/news` | Fetches news coverage scores from NewsAPI.org |
| `services/storage` | Supabase client and DB insert helpers |
| `apps/web` | Next.js 15 frontend with live chart, SSE streaming, swim-lane signal bands |

---

## Detection System

The system runs two complementary detectors in parallel. Each is optimized for a different latency/accuracy trade-off.

### 1. Multi-Window Movement Detector

**File:** `services/movements/src/detectMovement.ts`

Replaces the legacy single 24h detector with four parallel detection windows, each calibrated for prediction market dynamics. Runs on every qualifying trade with a single outer DB fetch (4h window) and per-window filtering.

#### Window Definitions

| Window | Duration | Price Threshold | Thin Threshold | Min Abs Move | Purpose |
|---|---|---|---|---|---|
| **5m** | 5 min | 3% | 5% | 2c | Impulse detection — catches catalyst-driven spikes |
| **15m** | 15 min | 4% | 7% | 2c | Momentum confirmation — validates 5m signals |
| **1h** | 1 hour | 6% | 10% | 3c | Sustained move — structural shift in pricing |
| **4h** | 4 hours | 8% | 12% | 3c | Regime change — filters daily noise |
| **event** | Variable | Inherited | Inherited | Inherited | Since-last-signal anchoring |

Each window also supports a volume threshold (default 1.5x baseline) and minimum tick/trade counts to prevent firing on sparse data.

#### Why Multi-Window?

Prediction markets are impulse-driven, not drift-driven like equities. A significant move in a binary market typically happens in minutes (news breaks, poll drops, ruling announced), not hours. The old 24h window would fire after the move was already over — by the time an 8% 24h drift triggers, the information is fully priced in.

Multi-window detection catches moves at different stages:
- **5m** fires during the initial impulse while the move is still actionable
- **15m** confirms the impulse wasn't just a blip
- **1h** validates that the move has sustained through follow-on activity
- **4h** identifies regime shifts and filters out noise

#### Velocity Metric

The detector computes a velocity score for every movement:

```
velocity = |price_delta| / sqrt(window_minutes)
```

This is standard diffusion scaling. A 3% move in 5 minutes produces velocity = 0.013, while an 8% move in 4 hours produces velocity = 0.005. The faster move scores higher because it represents a sharper information arrival.

The velocity threshold (default 0.008) can independently trigger a movement with reason `VELOCITY`, even when standard price/volume thresholds aren't breached.

#### Data Collection

The detector makes a single outer DB fetch for the 4h window, then filters per window:

**Trades (outer 4h window):**
- Queries the `trades` table for the target market + outcome
- Per window: filters to the window's time range, computes volume, trade count, unique price levels, avg trade size

**Mid-Price Ticks (outer 4h window):**
- Queries `market_mid_ticks` (order-book mid prices)
- Per window: computes start/end/min/max mid, drift, range, avg spread

**Baseline Volume:**
- Loads `market_aggregates` for total historical volume and `first_seen_at`
- Calculates `baselineDaily` = total_volume / observed_days (capped at 30 days)
- Requires at least 7 days of history before volume comparisons are reliable

**Hourly Spikes:**
- Buckets trades into hourly bins within the window
- Finds peak hourly volume and computes `hourlyRatio` against baseline

#### Price Detection Logic

A price movement fires when ALL of these conditions are met:

1. **Has ticks:** At least N mid-price ticks exist in the window (2 for 5m, up to 5 for 4h)
2. **Price eligible:** The minimum mid-price >= 0.05 (filters out near-zero noise)
3. **Absolute move:** |max - min| >= the window's `minAbsMove` threshold
4. **Threshold breach:** Either `midDriftPct` OR `midRangePct` exceeds the window's price threshold
   - Normal market: window-specific threshold (3% for 5m, 8% for 4h)
   - Thin liquidity: elevated threshold (5% for 5m, 12% for 4h)

#### Volume Detection Logic

A volume movement fires when EITHER:

- `volumeRatio` (window volume / baseline daily) >= window's volume threshold (default 1.5x)
- `hourlyRatio` (peak hour / baseline hourly) >= same threshold

#### Velocity Detection Logic

A velocity movement fires when:

- `velocity` >= `VELOCITY_THRESHOLD` (default 0.008)
- AND at least the minimum number of ticks exist in the window

This catches fast, sharp moves that may not breach the absolute price threshold.

#### Price Confirmation

When price thresholds are breached but volume has NOT confirmed:

1. Look at the last N minutes of ticks (default: 5 minutes, `MOVEMENT_CONFIRM_MINUTES`)
2. Require at least M ticks in that window (default: 3, `MOVEMENT_CONFIRM_MIN_TICKS`)
3. For upward moves: confirm if recent minimum sustains >= 50% of threshold above start
4. For downward moves: confirm if recent maximum sustains >= 50% of threshold below start
5. Alternatively, confirm if absolute move >= window's `minAbsMove`

#### Event-Anchored Detection

When a previous movement exists for this market, the detector re-anchors its start price to the end price of the last movement. This creates an "event" window that detects continued price movement since the last signal, using the longest active window's thresholds.

#### Liquidity Guard

The detector flags markets as "thin liquidity" when ANY of:

| Condition | Threshold |
|---|---|
| Average bid-ask spread | >= 5% |
| Trade count (in window) | < 15 |
| Unique price levels | < 8 |

When thin liquidity is detected:
- Price thresholds increase to the window's `thinPriceThreshold`
- The `thin_liquidity` flag is stored on the movement row
- Signal scoring penalizes confidence

#### Idempotency

Each movement gets a deterministic ID: `{marketId}:{outcome}:{windowType}:{bucket}`.

The bucket divisor varies by window type (5m buckets for 5m windows, 1h buckets for 4h windows). This limits output to one movement per market+outcome per bucket per window type. Duplicate-key inserts are silently skipped.

Per-window anti-spam cooldowns prevent re-running the detector too frequently (30s for 5m, 60s for longer windows).

#### Output

On trigger, inserts a row into `market_movements` with all computed metrics plus velocity, then calls `scoreSignals()` for classification and explanation generation.

#### Event-Level Detection

**File:** `services/movements/src/detectMovementEvent.ts`

For multi-outcome events (e.g., "Who will win the election?" with many candidates), the event detector aggregates across child markets using volume-weighted price composites. It runs 1h and 4h windows (shorter windows don't apply well to cross-market aggregation) and computes velocity the same way.

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

After a movement is detected, the scoring system classifies it by likely driver and assigns a confidence score. This runs for all multi-window movements (not real-time breakouts).

### Score Components

Each movement is evaluated on six dimensions, all normalized to 0..1:

#### Capital Score — "Did money show up?"

```
capitalScore = 0.6 * clamp(volumeRatio / 2.0) + 0.4 * clamp(hourlyRatio / 2.0)
```

- 2x daily volume = max capital score
- Weighted 60% daily, 40% hourly spike

#### Price Score — "Did price meaningfully move?"

```
priceScore = 0.5 * clamp(drift / 0.15) + 0.5 * clamp(range / 0.15)
```

- 15% drift or range = max price score
- Drift captures sustained directional moves
- Range captures spikes and whipsaws

#### Velocity Score — "How fast did price move?"

```
velocityScore = clamp(velocity / 0.02)
```

- `velocity = |price_delta| / sqrt(minutes)` (from the detector)
- 0.02 velocity = max score (e.g., 5% move in ~6 minutes)
- Captures the speed of information arrival independent of magnitude

#### Liquidity Risk — "Is this movement trustworthy?"

```
tradeRisk  = clamp((15 - tradesCount) / 15)
levelRisk  = clamp((8 - priceLevels) / 8)
thinRisk   = thin ? 1 : 0

liquidityRisk = 0.6 * thinRisk + 0.25 * tradeRisk + 0.15 * levelRisk
```

#### Info Score — "Price moved without capital behind it"

```
infoScore = priceScore * (1 - capitalScore) * (1 - clamp(volumeRatio / 2))
```

High info score means price moved significantly but volume was normal or low.

#### Time Score / News Score

- **Time Score:** Computed from `market_resolution` using proximity to `resolved_at` / `end_time`
- **News Score:** Fetched from NewsAPI.org, cached by slug+hour

### Classification

Evaluated in priority order (first match wins):

| Priority | Condition | Classification |
|---|---|---|
| 1 | `thin AND liquidityRisk >= 0.6` OR `liquidityRisk >= 0.75` | **LIQUIDITY** — Don't trust the move |
| 2 | `newsScore >= 0.5 AND infoScore >= 0.3` | **NEWS** — Driven by news coverage |
| 3 | `velocityScore >= 0.6 AND priceScore >= 0.3` | **VELOCITY** — Rapid impulse move |
| 4 | `capitalScore >= 0.6` | **CAPITAL** — Large money flows |
| 5 | `infoScore >= 0.5 AND hasInfoDepth` | **INFO** — Information/sentiment driven |
| 6 | `priceScore >= 0.6 AND thin` | **LIQUIDITY** — Price moved but book is thin |
| 7 | `priceScore >= 0.6 AND !thin` | **INFO** — Price moved, capital ambiguous |
| 8 | `timeScore > confidence` | **TIME** — Time dynamics |
| 9 | Fallback | **CAPITAL** — Default bucket |

### Recency Weighting

Shorter detection windows produce more actionable signals. A recency multiplier adjusts final confidence based on the source window:

| Window | Recency Weight |
|---|---|
| 5m | 1.00 |
| 15m | 0.85 |
| event | 0.80 |
| 1h | 0.65 |
| 4h | 0.45 |
| 24h (legacy) | 0.25 |

### Confidence Adjustment

All signals receive a final liquidity penalty and recency boost:

```
adjustedConfidence = confidence * (1 - 0.35 * liquidityRisk) * (0.5 + 0.5 * recency)
```

This means:
- Thin markets can reduce confidence by up to 35%
- A 5m signal gets full confidence; a 4h signal gets ~72% of raw confidence

### Output

Inserts into `signal_scores`:
- `movement_id`, `capital_score`, `info_score`, `time_score`, `news_score`
- `classification` (CAPITAL | INFO | VELOCITY | LIQUIDITY | NEWS | TIME)
- `confidence` (0..1, adjusted for liquidity risk and recency)

Then calls `buildExplanation()` and inserts the result into `movement_explanations`.

---

## Explanation Generation

**File:** `services/explanations/src/buildExplanation.ts`

Generates plain-English summaries by composing sentences:

1. **Price sentence:** "Price moved X% over Y min/hours." (adapts units to window size)
2. **Window sentence:** Window-specific context (e.g., "This is a rapid impulse detected in the 5-minute window." vs "This is a sustained move over the 4-hour window.")
3. **Volume sentence:** Based on volume ratio — below average, near typical, spiked above normal, or insufficient baseline
4. **Liquidity sentence:** "Orderbook appears thin, so price moves may be exaggerated." (if applicable)
5. **Classification sentence:** Maps classification to a human-readable driver explanation
6. **Velocity sentence:** "Velocity is high — sharp move relative to window size." (if reason is VELOCITY)
7. **News sentence:** Related headline excerpts (if available)

---

## Frontend

**File:** `apps/web/src/app/page.tsx`

### Live Signal Display

Signal annotations appear as colored bands at the bottom of the price chart. When multiple signals overlap in time, they are assigned to **swim lanes** — each lane is a separate vertical row, preventing bands from stacking on top of each other and blocking hover interactions.

- **Green bands:** Short-window impulses (5m, 15m) — high urgency
- **Orange bands:** Longer-window signals (1h, 4h) — contextual
- **Blue bands:** Event-level aggregated movements

Hovering a band shows a tooltip with the signal label, time window, and full explanation text.

### Live Signal Updates

New signals arrive in real-time via Server-Sent Events (SSE) without requiring a page reload:

1. The `/api/stream` endpoint polls `market_movements` every 2 seconds for new rows
2. New movements are pushed as `movement` SSE events with explanation text
3. The frontend receives them via `useMarketStream` and appends to the annotation arrays
4. New signal bands appear immediately on the chart
5. The signal pill in the header pulses green when new signals arrive
6. A manual refresh button (&#x21bb;) on the signal pill re-fetches the full signal history from the API

### Signal Pill

Shows `Signals: N · Last HH:MM:SS` in the header. Pulses when new signals arrive via the stream. Clicking the refresh button triggers an API re-fetch that merges any missing signals without losing live series data.

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
Polymarket CLOB WS message (batched, max 20 assets per connection)
  → Extract synthetic mid-price from best bid/ask
  → Filter for "Yes" outcome only
  → movementRealtime.onPriceUpdate()
      → EMA update → Bucket update → Stability check
      → checkBreakout() / checkEmaCross()
      → emitEvent() → movement_events table
  → Store mid-tick to market_mid_ticks (deduplicated)
```

### Dynamic Slug Management

Tracked slugs are stored in Supabase `tracked_slugs` table. The ingestion service polls this table every 30 seconds (`syncTrackedSlugs()`), merging new slugs into its active filter set without requiring a restart. Adding new slugs triggers an immediate backfill.

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
| `market_movements` | Detected multi-window and event-anchored movements with full metrics |
| `market_resolution` | Market end times and resolution status for time-score computation |
| `movement_events` | Real-time breakout and EMA crossover detections |
| `signal_scores` | Classification and confidence scores per movement |
| `movement_explanations` | Human-readable explanation text per movement |
| `tracked_slugs` | Slugs registered for tracking (shared between frontend and ingestion) |

---

## Configuration

All detection thresholds are configurable via environment variables:

### Multi-Window Movement Detector

#### 5-Minute Window

| Variable | Default | Description |
|---|---|---|
| `MOVEMENT_5M_PRICE_THRESHOLD` | 0.03 | Min price drift/range to trigger (3%) |
| `MOVEMENT_5M_THIN_THRESHOLD` | 0.05 | Price threshold when liquidity is thin (5%) |
| `MOVEMENT_5M_MIN_ABS` | 0.02 | Minimum absolute price change (2 cents) |
| `MOVEMENT_5M_VOLUME_THRESHOLD` | 1.5 | Volume ratio multiplier |
| `MOVEMENT_5M_COOLDOWN_MS` | 30000 | Anti-spam cooldown (30s) |

#### 15-Minute Window

| Variable | Default | Description |
|---|---|---|
| `MOVEMENT_15M_PRICE_THRESHOLD` | 0.04 | Min price drift/range to trigger (4%) |
| `MOVEMENT_15M_THIN_THRESHOLD` | 0.07 | Price threshold when liquidity is thin (7%) |
| `MOVEMENT_15M_MIN_ABS` | 0.02 | Minimum absolute price change (2 cents) |
| `MOVEMENT_15M_VOLUME_THRESHOLD` | 1.5 | Volume ratio multiplier |
| `MOVEMENT_15M_COOLDOWN_MS` | 60000 | Anti-spam cooldown (60s) |

#### 1-Hour Window

| Variable | Default | Description |
|---|---|---|
| `MOVEMENT_1H_PRICE_THRESHOLD` | 0.06 | Min price drift/range to trigger (6%) |
| `MOVEMENT_1H_THIN_THRESHOLD` | 0.10 | Price threshold when liquidity is thin (10%) |
| `MOVEMENT_1H_MIN_ABS` | 0.03 | Minimum absolute price change (3 cents) |
| `MOVEMENT_1H_VOLUME_THRESHOLD` | 1.5 | Volume ratio multiplier |
| `MOVEMENT_1H_COOLDOWN_MS` | 60000 | Anti-spam cooldown (60s) |

#### 4-Hour Window

| Variable | Default | Description |
|---|---|---|
| `MOVEMENT_4H_PRICE_THRESHOLD` | 0.08 | Min price drift/range to trigger (8%) |
| `MOVEMENT_4H_THIN_THRESHOLD` | 0.12 | Price threshold when liquidity is thin (12%) |
| `MOVEMENT_4H_MIN_ABS` | 0.03 | Minimum absolute price change (3 cents) |
| `MOVEMENT_4H_VOLUME_THRESHOLD` | 1.5 | Volume ratio multiplier |
| `MOVEMENT_4H_COOLDOWN_MS` | 60000 | Anti-spam cooldown (60s) |

#### Shared

| Variable | Default | Description |
|---|---|---|
| `MOVEMENT_MIN_PRICE_FOR_ALERT` | 0.05 | Skip markets with mid below this level |
| `MOVEMENT_CONFIRM_MINUTES` | 5 | Minutes to look back for price confirmation |
| `MOVEMENT_CONFIRM_MIN_TICKS` | 3 | Minimum ticks required for confirmation |
| `MOVEMENT_VELOCITY_THRESHOLD` | 0.008 | Velocity threshold for VELOCITY trigger |

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
| `TIME_SCORE_HORIZON_HOURS` | 72 | Hours before resolution where time score ramps |
| `TIME_SCORE_CACHE_MS` | 60000 | Cache TTL for time score lookups |

### Ingestion

| Variable | Default | Description |
|---|---|---|
| `MAX_CLOB_ASSETS` | 20 | Max assets per CLOB WebSocket connection |
| `MAX_ASSETS_PER_MARKET` | 3 | Max assets tracked per market |

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
5. New signals appear live via SSE — the signal pill pulses green when new signals arrive
6. Click the refresh button on the signal pill to re-fetch historical signals without reloading

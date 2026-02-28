# Market Move Intelligence

Real-time detection of price movements on Polymarket. Ingests trades and order-book data via WebSocket, detects movements across multiple time windows, classifies them by likely driver, and shows annotated signals on a live chart.

## Architecture

```
Polymarket WS (trades)  ──┐
                           ├──▶  Ingestion  ──▶  Supabase
Polymarket WS (CLOB)    ──┘       │                 │
                           ┌──────┴──────┐          │
                           ▼              ▼          │
                    Multi-Window     Realtime         │
                    (5m/15m/1h/4h)   (in-memory)     │
                           │              │          │
                           ▼              ▼          │
                    Signal Scorer    movement_events  │
                           │                         │
                           ▼                         │
                    AI Explanations (Groq)            │
                           │                         │
                           ▼                         │
                    Next.js Frontend  ◀── SSE ◀──────┘
```

| Directory | What it does |
|---|---|
| `services/ingestion` | WebSocket connections, data normalization, storage, detection orchestration |
| `services/movements` | Multi-window detector (DB-backed) + realtime detector (in-memory) |
| `services/signals` | Classifies movements as CAPITAL / INFO / VELOCITY / LIQUIDITY / NEWS / TIME |
| `services/explanations` | AI explanations via Groq Llama 3.3 70B, with template fallback |
| `services/news` | News coverage scoring from NewsAPI.org |
| `services/storage` | Supabase client and DB helpers |
| `apps/web` | Next.js 15 frontend with live chart and SSE streaming |

## Detection

Two detectors run in parallel.

### Multi-Window Detector (`detectMovement.ts`)

Runs on each trade. Makes one DB fetch (4h lookback), then evaluates four windows:

| Window | Price Threshold | Thin Threshold | What it catches |
|---|---|---|---|
| 5m | 3% | 5% | Impulse — catalyst-driven spikes |
| 15m | 4% | 7% | Momentum — validates the impulse wasn't a blip |
| 1h | 6% | 10% | Sustained move — structural repricing |
| 4h | 8% | 12% | Regime change — filters daily noise |

Each window also checks volume (1.5x baseline) and velocity (`|price_delta| / sqrt(minutes)`). Markets with wide spreads, few trades, or few price levels are flagged as thin liquidity with elevated thresholds.

Movements get a deterministic ID per window+bucket so duplicates are silently skipped.

### Realtime Detector (`detectMovementRealtime.ts`)

In-memory state machine watching live mid-prices. No DB queries. Detects:

- **Breakout**: Price breaks 60-min high/low by 3%+
- **EMA Cross**: 1-min EMA crosses 5-min EMA with 3-tick confirmation

Requires price stability (3 ticks or 5s at same level) and a recent trade (within 60s) before firing.

## Signal Scoring (`scoreSignals.ts`)

Each movement is scored on six dimensions (0-1 scale), then classified by priority:

1. **LIQUIDITY** — thin book, don't trust the move
2. **NEWS** — driven by news coverage
3. **VELOCITY** — rapid impulse
4. **CAPITAL** — large money flows
5. **INFO** — price moved without volume
6. **TIME** — approaching resolution

Confidence is penalized by liquidity risk (up to 35%) and boosted by recency (5m signals get full weight, 4h signals ~72%).

## Running

### Prerequisites

- Node.js 18+
- Supabase project (see `sql/` for migrations)

### Environment

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
GROQ_API_KEY=gsk_...                           # optional, enables AI explanations
```

### Start

```bash
npm install

# Ingestion
npx tsx services/ingestion/src/index.ts

# Frontend (port 3005)
npm --workspace @market-move-intelligence/web run dev
```

Load a Polymarket event slug in the UI. The ingestion service picks it up within 30 seconds and starts streaming data to the chart.

## Configuration

All thresholds are tunable via env vars. The naming pattern is:

- `MOVEMENT_{5M,15M,1H,4H}_PRICE_THRESHOLD` — price trigger per window
- `MOVEMENT_{5M,15M,1H,4H}_THIN_THRESHOLD` — elevated threshold for thin markets
- `MOVEMENT_{5M,15M,1H,4H}_VOLUME_THRESHOLD` — volume ratio trigger
- `MOVEMENT_RT_*` — realtime detector params (see `detectMovementRealtime.ts`)
- `MAX_CLOB_ASSETS` — assets per CLOB WebSocket connection (default 20)

Full list of env vars and defaults are documented inline in the source files.

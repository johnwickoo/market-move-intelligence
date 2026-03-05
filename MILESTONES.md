# Milestones

## Completed

### Core Pipeline
- [x] Trade ingestion via Polymarket WebSocket (activity feed)
- [x] CLOB order-book ingestion for mid-price ticks
- [x] Supabase storage layer (trades, mid ticks, aggregates, movements)
- [x] Trade deduplication and buffered batch inserts
- [x] Trade backfill from Polymarket data API on startup
- [x] Dynamic slug tracking from frontend (tracked_slugs table, 30s sync)
- [x] Multi-market event support (event slug → N child markets, per-child hydration)
- [x] CLOB asset batching across multiple WebSocket connections (20 assets/conn)
- [x] CLOB reconnection hardening (destroyed flag prevents ghost connections)
- [x] Market resolution detection with 30-min grace period
- [x] Jupiter prediction market ingestion (REST polling with rate limiting, auto-discovery)

### Movement Detection
- [x] Multi-window detector: 5m / 15m / 1h / 4h with per-window thresholds
- [x] Velocity metric: `|Δprice| / √(minutes)` for speed-of-information scoring
- [x] Event-anchored detection (re-anchors start price to last movement's end)
- [x] Realtime in-memory detector: 60-min breakout + EMA crossover
- [x] Two-stage finalize pipeline (classify once momentum settles, then explain)
- [x] Liquidity guard (thin spread / low trade count / few price levels)
- [x] Event-level detection for multi-outcome markets

### Signal Scoring & Explanations
- [x] Six-dimension scoring: capital, price, velocity, info, liquidity, time
- [x] Classification: CAPITAL / INFO / VELOCITY / LIQUIDITY / NEWS / TIME
- [x] Recency weighting (5m signals = full weight, 4h = 72%)
- [x] AI explanations via Groq Llama 3.3 70B with template fallback
- [x] AI-generated news search keywords for better NewsAPI coverage
- [x] News score integration from NewsAPI.org

### Frontend
- [x] Live price chart with lightweight-charts
- [x] SSE streaming for real-time signal updates
- [x] Multi-outcome charting for event markets (one line per child, color-coded)
- [x] Signal annotation bands with swim-lane layout
- [x] Outcome filter pills for multi-market events
- [x] Signal pill with count, last-signal time, and pulse on new signals

### On-Chain
- [x] Solana attestation service (memo + program modes via Jupiter)

---

## In Progress

### Multi-Window Detection Refinement
- [ ] Calibrate 5m thresholds against live data (current 3% may be too sensitive for low-vol markets)
- [ ] Tune EMA time constants (1m/5m) for different market types (binary vs multi-outcome)

---

## Roadmap

### Phase 1: Signal Validation (Weeks 1–4)
**Goal:** Prove signal accuracy with real data before building on top of it.

#### 30-Day Signal Tracking Campaign
Pick one high-volume market (e.g., a US election or crypto price market on Polymarket) and run the full pipeline continuously for 30 days.

- [ ] Record price at +5m, +15m, +1h, +4h after every signal fires
- [ ] Log signal classification, confidence score, and window that triggered
- [ ] Build a simple accuracy dashboard: what % of signals predicted the right direction?
- [ ] Compare classification accuracy (INFO vs CAPITAL vs VELOCITY — which is most reliable?)
- [ ] Tune thresholds based on observed false positive / false negative rates
- [ ] Document findings in a calibration report

**Timeline:** 30 days continuous tracking + 1 week analysis
**Resources:** Supabase pro plan (~$25/mo for sustained ingestion), one always-on process (VPS or local machine), NewsAPI free tier (100 req/day)

---

### Phase 2: Database Optimization (Weeks 3–6)
**Priority: High** — The biggest operational constraint. Supabase free/pro tiers hit bandwidth and storage limits fast. `market_mid_ticks` and `trades` are the primary offenders.

- [ ] **Mid-tick downsampling**: Store 1s ticks for the last hour, downsample to 5s for 24h, 1m for 7d. Cron job compresses old ticks in-place.
- [ ] **Trades retention policy**: Keep raw trades for 48h, roll up to hourly aggregates. `market_aggregates` already has the summary.
- [ ] **Partitioned tables**: Partition `market_mid_ticks` by day and `trades` by week. Drop old partitions instead of DELETE queries.
- [ ] **Evaluate TimescaleDB**: Continuous aggregates built-in, stays on Postgres. Compare against Supabase pro plan limits.

**Timeline:** 2–3 weeks (downsampling + retention first, partitioning/TimescaleDB evaluation second)
**Resources:** Supabase pro ($25/mo) or self-hosted Postgres with TimescaleDB (~$10–20/mo on a VPS). No additional API keys needed.

---

### Phase 3: Scoring Refinement (Weeks 5–8)
**Priority: High** — Depends on Phase 1 tracking data to inform tuning decisions.

- [ ] **Adaptive thresholds**: Use 7-day rolling standard deviation of mid-price returns to normalize per market. High-vol markets get higher thresholds automatically.
- [ ] **Whale detection**: Flag trades in the top 5% by size for that market. One large trade vs. many small trades = different signal quality.
- [ ] **Order-book imbalance signal**: Bid/ask size ratio from CLOB data. Heavy bid-side imbalance before a move suggests informed buying.
- [ ] **Backtesting framework**: Replay historical trades through the detector and compare against recorded outcomes from Phase 1.

**Timeline:** 3–4 weeks (adaptive thresholds + whale detection first, backtesting after 30-day data is available)
**Resources:** Stored Phase 1 data, compute for replay (~few hours on a modern machine). No new API keys.

---

### Phase 4: Frontend Polish (Weeks 6–10)
**Priority: Medium**

- [ ] **Market search/discovery**: Search-as-you-type against Polymarket's public API instead of pasting slugs.
- [ ] **Signal history panel**: Scrollable list of past signals with explanations, filterable by classification.
- [ ] **Multi-market dashboard**: Watch multiple slugs simultaneously in a grid layout.
- [ ] **Dark mode**: Chart library supports it, just needs theme wiring.
- [ ] **Mobile responsive**: Controls layout for smaller screens.
- [ ] **Alert notifications**: Browser push or webhook/Telegram when a high-confidence signal fires.

**Timeline:** 4–5 weeks (search + history panel first, dashboard + alerts last)
**Resources:** Polymarket public API (free, no key needed for search). Telegram Bot API (free) for alerts.

---

### Phase 5: Crypto Price Oracle Integration (Weeks 8–10)
**Priority: Medium** — For prediction markets that reference crypto prices ("Will BTC hit $X by date Y").

- [ ] **CoinGecko API**: Pull spot prices for BTC, ETH, SOL and assets referenced in tracked market titles. Free tier: 30 calls/min.
- [ ] **Correlation scoring**: New score dimension — does the prediction market move correlate with spot price? High correlation = tracking spot. Low correlation = information-driven. Strong differentiator for INFO vs CAPITAL classification.
- [ ] **Pyth / Chainlink price feeds**: On-chain oracles for lower latency. Relevant if moving more on-chain.

**Timeline:** 2–3 weeks
**Resources:** CoinGecko API key (free tier sufficient for 5–10 markets). Pyth/Chainlink require Solana/EVM RPC endpoints.

---

### Phase 6: Prediction Market Partnerships (Weeks 10–16)
**Priority: Medium** — Requires a proven track record from Phase 1 and polished frontend from Phase 4.

- [ ] **Polymarket**: The primary data source. Pitch: embeddable signal overlay for Polymarket's own UI, or a public-facing signal dashboard that drives traffic back to Polymarket. Leverage the existing deep integration (WebSocket, CLOB, backfill) as proof of technical capability.
- [ ] **Jupiter (Solana)**: Attestation service already scaffolded. Pitch: on-chain signal attestation for Jupiter prediction markets, verifiable track record via Solana memos.
- [ ] **Azuro / Overtime (EVM)**: Sports/prediction markets. Would need an ingestion adapter but the detection + scoring pipeline is market-agnostic.
- [ ] **Signal marketplace / API**: Package signals as a feed that prediction market UIs can embed (widget or API). Revenue via data licensing or attribution.

**Timeline:** 6+ weeks (outreach + integration work per partner). Polymarket and Jupiter first, others after establishing the pattern.
**Resources:** 30-day accuracy report from Phase 1 (the pitch deck). Azuro/Overtime adapters require ~1 week each for the ingestion layer.

---

### Phase 7: Signal as an Indicator (Weeks 14+)
**Priority: Long-term** — The end goal. Make this a tool people use as a leading indicator, not just a monitoring dashboard.

- [ ] **Signal accuracy tracking (public)**: Publish hit rates by classification as a live track record on the frontend.
- [ ] **Composite signal index**: Aggregate across multiple markets into a single "prediction market activity index." Useful as a macro risk indicator.
- [ ] **API access**: REST + WebSocket API for programmatic signal consumption. Rate-limited free tier, authenticated paid tier.
- [ ] **TradingView integration**: Publish signals as a TradingView indicator or webhook-driven alerts. Highest-leverage distribution channel for traders.
- [ ] **Embeddable widget**: Drop-in chart + signal component for prediction market frontends. Revenue via attribution or data licensing.

**Timeline:** Ongoing. API + TradingView integration: ~3–4 weeks. Widget: ~2 weeks.
**Resources:** TradingView Pine Script or webhook integration (free for personal indicators). API hosting: existing VPS or serverless functions. Domain + SSL for public API.

---

## Resources Summary

| Resource | Cost | Phase |
|----------|------|-------|
| Supabase Pro | ~$25/mo | All phases |
| VPS (always-on ingestion) | ~$10–20/mo | All phases |
| NewsAPI | Free (100 req/day) | Phase 1+ |
| CoinGecko API | Free tier | Phase 5 |
| Groq API | Free tier (Llama 3.3 70B) | All phases |
| Telegram Bot API | Free | Phase 4 (alerts) |
| Polymarket APIs | Free (public) | All phases |
| Solana RPC | Free tier (Helius/Quicknode) | Phase 6 (attestation) |
| Domain + SSL | ~$12/yr | Phase 7 (public API) |

**Estimated monthly running cost:** $35–45/mo for core infrastructure. No paid API keys required at current scale.

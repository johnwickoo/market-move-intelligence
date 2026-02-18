import { supabase } from "../../storage/src/db";
import { buildExplanation } from "../../explanations/src/buildExplanation";
import { resolveSlugAndTitle } from "../../news/src/newsapi.client";
import { fetchRelevantNewsForMovement } from "../../news/src/fetchRelevantNews";
import { computeTimeScore, parseTimeValue } from "./timeScore";
import { attestSignal } from "../../chain/src/attestSignal";
import type { SignalClassification } from "../../chain/src/types";

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function safeNum(x: any, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

const TIME_SCORE_HORIZON_HOURS = Number(process.env.TIME_SCORE_HORIZON_HOURS ?? 72);
const TIME_SCORE_CACHE_MS = Number(process.env.TIME_SCORE_CACHE_MS ?? 60_000);
const timeScoreCache = new Map<
  string,
  { ts: number; score: number; targetMs: number | null }
>();

async function fetchTimeScore(marketId: string) {
  const now = Date.now();
  const cached = timeScoreCache.get(marketId);
  if (cached && now - cached.ts < TIME_SCORE_CACHE_MS) {
    return cached;
  }

  const { data, error } = await supabase
    .from("market_resolution")
    .select("end_time,resolved_at,resolved,status")
    .eq("market_id", marketId)
    .maybeSingle();

  if (error || !data) {
    const fallback = { ts: now, score: 0, targetMs: null };
    timeScoreCache.set(marketId, fallback);
    return fallback;
  }

  const resolvedAtMs = parseTimeValue((data as any).resolved_at);
  const endTimeMs = parseTimeValue((data as any).end_time);
  const targetMs = resolvedAtMs ?? endTimeMs;
  const resolvedFlag = Boolean((data as any).resolved);
  const status = (data as any).status ? String((data as any).status) : null;
  const score = computeTimeScore({
    targetMs,
    resolved: resolvedFlag,
    status,
    nowMs: now,
    horizonHours: TIME_SCORE_HORIZON_HOURS,
  });

  const out = { ts: now, score, targetMs };
  timeScoreCache.set(marketId, out);
  return out;
}

// ── Recency multiplier ───────────────────────────────────────────────
// Shorter detection windows produce more actionable signals on a live
// dashboard. A 5m signal is ~4x more actionable than a 4h signal.
const RECENCY_WEIGHTS: Record<string, number> = {
  "5m": 1.0,
  "15m": 0.85,
  "1h": 0.65,
  "4h": 0.45,
  "event": 0.80,
  // Legacy compatibility
  "24h": 0.25,
};

function recencyMultiplier(windowType: string): number {
  return RECENCY_WEIGHTS[windowType] ?? 0.5;
}

export async function scoreSignals(movement: any) {
  const reason = String(movement.reason ?? "");
  const thin = Boolean(movement.thin_liquidity);
  const windowType = String(movement.window_type ?? "");

  // PRICE signals
  const drift = Math.abs(safeNum(movement.pct_change, 0));
  const range = Math.abs(safeNum(movement.range_pct, 0));

  // VOLUME signals
  const volumeRatioRaw = movement.volume_ratio;
  const hourlyRatioRaw = movement.hourly_volume_ratio;
  const volumeRatio = safeNum(volumeRatioRaw, 0);
  const hourlyRatio = safeNum(hourlyRatioRaw, 0);

  // Liquidity stats
  const tradesCount = safeNum(movement.trades_count_24h, 0);
  const priceLevels = safeNum(movement.unique_price_levels_24h, 0);
  const avgTradeSize = safeNum(movement.avg_trade_size_24h, 0);

  // Velocity from the detection engine
  const velocity = safeNum(movement.velocity, 0);

  const MIN_INFO_TRADES = Number(process.env.MIN_INFO_TRADES ?? 50);
  const MIN_INFO_LEVELS = Number(process.env.MIN_INFO_LEVELS ?? 8);
  const hasInfoDepth = tradesCount >= MIN_INFO_TRADES || priceLevels >= MIN_INFO_LEVELS;

  const LIQUIDITY_OVERRIDE = Number(process.env.LIQUIDITY_OVERRIDE ?? 0.6);

  /**
   * 1) CAPITAL SCORE (0..1)
   * "Did money show up?"
   */
  const capitalScore =
    0.6 * clamp01(volumeRatio / 2) +
    0.4 * clamp01(hourlyRatio / 2);

  /**
   * 2) PRICE SCORE (0..1)
   * "Did price meaningfully move?"
   * Scaled to window-appropriate thresholds (15% is the 4h reference).
   */
  const priceScore =
    0.5 * clamp01(drift / 0.15) +
    0.5 * clamp01(range / 0.15);

  /**
   * 3) VELOCITY SCORE (0..1) — NEW
   * "How fast did price move relative to time?"
   * Velocity = |drift| / sqrt(minutes). Scaled so 0.02 = strong signal.
   */
  const velocityScore = clamp01(velocity / 0.02);

  /**
   * 4) LIQUIDITY RISK (0..1)
   */
  const tradeRisk = tradesCount <= 0 ? 1 : clamp01((15 - tradesCount) / 15);
  const levelRisk = priceLevels <= 0 ? 1 : clamp01((8 - priceLevels) / 8);
  const thinRisk = thin ? 1 : 0;

  const liquidityRisk =
    0.6 * thinRisk +
    0.25 * tradeRisk +
    0.15 * levelRisk;

  /**
   * 5) INFO SCORE (0..1)
   * "Price moved without capital behind it"
   */
  const infoScoreRaw =
    priceScore * (1 - capitalScore) * (1 - clamp01(volumeRatio / 2));
  const infoScore = clamp01(infoScoreRaw);

  /**
   * 6) TIME SCORE
   */
  let timeScore = 0;
  try {
    const timeResult = await fetchTimeScore(movement.market_id);
    timeScore = timeResult.score;
  } catch (err: any) {
    console.warn("[signals] time score fetch failed, defaulting to 0", err?.message);
  }

  /**
   * 7) NEWS SCORE (0..1) — entity-aware, time-aligned news relevance
   */
  let newsScore = 0;
  let newsHeadlines: string[] = [];
  try {
    const newsResult = await fetchRelevantNewsForMovement(
      movement.market_id,
      movement.window_end ?? new Date().toISOString(),
      windowType
    );
    newsScore = newsResult.score;
    newsHeadlines = newsResult.topHeadlines;
    if (newsResult.entityContext.category !== "other") {
      console.log(
        "[signals] news entity:",
        newsResult.entityContext.canonicalEntity,
        `(${newsResult.entityContext.category})`,
        `articles=${newsResult.articleCount}`,
        `cached=${newsResult.cached}`
      );
    }
  } catch (err: any) {
    console.warn("[signals] news fetch failed, defaulting to 0", err?.message);
  }

  /**
   * 8) Classification logic
   *
   * Priority order:
   * 1. LIQUIDITY — don't trust the move
   * 2. NEWS — strong news coverage + meaningful info signal
   * 3. VELOCITY — fast impulse move (new)
   * 4. CAPITAL — large money flows
   * 5. INFO — price moved without capital
   * 6. TIME — fallback
   */
  let classification = "CAPITAL";
  let confidence = capitalScore;

  // 1) Liquidity override
  if (thin && liquidityRisk >= LIQUIDITY_OVERRIDE) {
    classification = "LIQUIDITY";
    confidence = liquidityRisk;
  } else if (liquidityRisk >= 0.75) {
    classification = "LIQUIDITY";
    confidence = liquidityRisk;
  }
  // 2) NEWS
  else if (newsScore >= 0.5 && infoScore >= 0.3) {
    classification = "NEWS";
    confidence = newsScore * 0.6 + infoScore * 0.4;
  }
  // 3) VELOCITY — fast impulse move
  else if (velocityScore >= 0.6 && priceScore >= 0.3) {
    classification = "VELOCITY";
    confidence = velocityScore * 0.7 + priceScore * 0.3;
  }
  // 4) Capital
  else if (capitalScore >= 0.6) {
    classification = "CAPITAL";
    confidence = capitalScore;
  }
  // 5) Info
  else if (infoScore >= 0.5 && hasInfoDepth) {
    classification = "INFO";
    confidence = infoScore;
  }
  // 6) Price moved but ambiguous
  else if (priceScore >= 0.6) {
    if (thin) {
      classification = "LIQUIDITY";
      confidence = Math.max(liquidityRisk, 0.55);
    } else {
      classification = "INFO";
      confidence = priceScore;
    }
  }
  // 7) Time fallback
  else if (timeScore > confidence) {
    classification = "TIME";
    confidence = timeScore;
  }

  // Attach headlines to movement for buildExplanation
  (movement as any).__newsHeadlines = newsHeadlines;

  // Final confidence: apply liquidity penalty + recency multiplier
  const recency = recencyMultiplier(windowType);
  const adjustedConfidence = clamp01(
    confidence * (1 - 0.35 * liquidityRisk) * (0.5 + 0.5 * recency)
  );

  // Drop low-confidence signals — prevents LIQUIDITY and other weak
  // signals from cluttering the frontend and wasting AI explanation calls.
  const MIN_CONFIDENCE = Number(process.env.SIGNAL_MIN_CONFIDENCE ?? 0.25);
  if (adjustedConfidence < MIN_CONFIDENCE) {
    console.log(
      `[signals] skipped low-confidence`,
      movement.id,
      classification,
      adjustedConfidence.toFixed(3)
    );
    return;
  }

  const row = {
    movement_id: movement.id,
    capital_score: capitalScore,
    info_score: infoScore,
    time_score: timeScore,
    news_score: newsScore,
    classification,
    confidence: adjustedConfidence,
  };

  const { error } = await supabase.from("signal_scores").insert(row);
  if (error) {
    console.error("[signals] insert failed", error.message, row);
    throw error;
  }

  let marketTitle: string | undefined;
  try {
    // For event-level signals, resolve the top mover's child market title
    // so the explanation can name the specific market that drove the move.
    const topMoverId = (movement as any).__topMoverMarketId as string | null;
    const resolveId = topMoverId || movement.market_id;
    const resolved = await resolveSlugAndTitle(resolveId);
    marketTitle = resolved.title ?? undefined;

    // If we resolved a child market, prefix with event context
    if (topMoverId && marketTitle && movement.outcome === "EVENT") {
      const eventSlug = String(movement.market_id ?? "").replace(/^event:/, "");
      marketTitle = `${marketTitle} (event: ${eventSlug})`;
    }
  } catch {}

  const explanationText = await buildExplanation(movement, row, marketTitle);
  const { error: explainErr } = await supabase
    .from("movement_explanations")
    .insert({ movement_id: movement.id, text: explanationText });
  if (explainErr) {
    console.error("[explain] insert failed", explainErr.message, {
      movement_id: movement.id,
    });
    throw explainErr;
  }

  // Fire-and-forget: attest signal on Solana (non-blocking).
  // attestSignal never throws — failures are logged and swallowed.
  attestSignal({
    movement_id: movement.id,
    market_id: movement.market_id,
    classification: classification as SignalClassification,
    confidence: adjustedConfidence,
    capital_score: capitalScore,
    info_score: infoScore,
    time_score: timeScore,
    news_score: newsScore,
  });

  console.log(
    "[signals] inserted",
    row.movement_id,
    row.classification,
    row.confidence.toFixed(3),
    `window=${windowType}`,
    `recency=${recency.toFixed(2)}`
  );

  console.log("[signals] inputs", {
    reason,
    windowType,
    drift,
    range,
    velocity: velocity.toFixed(4),
    volumeRatio: volumeRatioRaw ?? "n/a",
    hourlyRatio: hourlyRatioRaw ?? "n/a",
    tradesCount,
    priceLevels,
    avgTradeSize,
    thin,
  });

  console.log("[signals] scores", {
    priceScore: priceScore.toFixed(3),
    velocityScore: velocityScore.toFixed(3),
    capitalScore: capitalScore.toFixed(3),
    infoScore: infoScore.toFixed(3),
    newsScore: newsScore.toFixed(3),
    timeScore: timeScore.toFixed(3),
    liquidityRisk: liquidityRisk.toFixed(3),
    recency: recency.toFixed(2),
  });

  console.log("[signals] gates", { hasInfoDepth, MIN_INFO_TRADES, MIN_INFO_LEVELS });

  console.log("[explain]", explanationText);
}

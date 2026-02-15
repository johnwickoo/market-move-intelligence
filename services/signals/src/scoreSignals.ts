import { supabase } from "../../storage/src/db";
import { buildExplanation } from "../../explanations/src/buildExplanation";
import { fetchNewsScore } from "../../news/src/newsapi.client";
import { computeTimeScore, parseTimeValue } from "./timeScore";

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

export async function scoreSignals(movement: any) {
  const reason = String(movement.reason ?? "");
  const thin = Boolean(movement.thin_liquidity);

  // PRICE signals
  const drift = Math.abs(safeNum(movement.pct_change, 0));  // e.g. 0.18
  const range = Math.abs(safeNum(movement.range_pct, 0));   // e.g. 0.35

  // VOLUME signals
  const volumeRatioRaw = movement.volume_ratio;
  const hourlyRatioRaw = movement.hourly_volume_ratio;
  const volumeRatio = safeNum(volumeRatioRaw, 0);          // 24h / baselineDaily
  const hourlyRatio = safeNum(hourlyRatioRaw, 0);   // maxHour / baselineHourly

  // Liquidity stats (optional; you already store these)
  const tradesCount = safeNum(movement.trades_count_24h, 0);
  const priceLevels = safeNum(movement.unique_price_levels_24h, 0);
  const avgTradeSize = safeNum(movement.avg_trade_size_24h, 0);

    // --- NEW: simple depth gates (tune later)
  const MIN_INFO_TRADES = Number(process.env.MIN_INFO_TRADES ?? 50);
  const MIN_INFO_LEVELS = Number(process.env.MIN_INFO_LEVELS ?? 8);

  const hasInfoDepth = tradesCount >= MIN_INFO_TRADES || priceLevels >= MIN_INFO_LEVELS;

  // --- NEW: thin liquidity override should be easier to trigger
  const LIQUIDITY_OVERRIDE = Number(process.env.LIQUIDITY_OVERRIDE ?? 0.6); // was 0.7

  /**
   * 1) CAPITAL SCORE (0..1)
   * "Did money show up?"
   * - daily ratio: 2x baseline => strong
   * - hourly ratio: 2x baseline hourly => strong
   * Use a soft scale so 2.0 maps to ~1.0.
   */
  const capitalScore =
    0.6 * clamp01(volumeRatio / 2) +
    0.4 * clamp01(hourlyRatio / 2);

  /**
   * 2) PRICE SCORE (0..1)
   * "Did price meaningfully move?"
   * Drift catches sustained move.
   * Range catches intraday spike/whipsaw.
   * 15% is your base movement threshold.
   */
  const priceScore =
    0.5 * clamp01(drift / 0.15) +
    0.5 * clamp01(range / 0.15);

  /**
   * 3) LIQUIDITY RISK (0..1)
   * "Is this movement likely unreliable due to thin orderbook?"
   * - thin flag is strongest signal
   * - low trades count or low price levels => higher risk
   */
  const tradeRisk = tradesCount <= 0 ? 1 : clamp01((15 - tradesCount) / 15); // <15 trades => risk
  const levelRisk = priceLevels <= 0 ? 1 : clamp01((8 - priceLevels) / 8);   // <8 levels => risk
  const thinRisk = thin ? 1 : 0;

  // Weight thinRisk heavily
  const liquidityRisk =
    0.6 * thinRisk +
    0.25 * tradeRisk +
    0.15 * levelRisk;

  /**
   * 4) INFO SCORE (0..1)
   * "Price moved without capital behind it"
   *
   * Idea:
   * - high priceScore
   * - low capitalScore
   * - low volumeRatio specifically (money didn’t show up)
   */
  const infoScoreRaw =
    priceScore * (1 - capitalScore) * (1 - clamp01(volumeRatio / 2));

  const infoScore = clamp01(infoScoreRaw);

  /**
   * 5) TIME SCORE
   * Based on proximity to resolution/end time (market_resolution table).
   */
  let timeScore = 0;
  try {
    const timeResult = await fetchTimeScore(movement.market_id);
    timeScore = timeResult.score;
  } catch (err: any) {
    console.warn("[signals] time score fetch failed, defaulting to 0", err?.message);
  }

  /**
   * 5b) NEWS SCORE (0..1)
   * "Is there recent news coverage related to this market?"
   * Fetched from NewsAPI.org, cached by slug+hour.
   */
  let newsScore = 0;
  let newsHeadlines: string[] = [];
  try {
    const newsResult = await fetchNewsScore(movement.market_id);
    newsScore = newsResult.score;
    newsHeadlines = newsResult.topHeadlines;
  } catch (err: any) {
    console.warn("[signals] news fetch failed, defaulting to 0", err?.message);
  }

  /**
   * 6) Classification logic (simple + explainable)
   *
   * Priority order:
   * 1. LIQUIDITY — don't trust the move
   * 2. NEWS — strong news coverage + meaningful info signal
   * 3. CAPITAL — large money flows
   * 4. INFO — price moved without capital
   * 5. TIME — fallback
   */
  let classification = "CAPITAL";
  let confidence = capitalScore;

  // 1) Liquidity override: if thin OR risk is high, we don't trust the move
  if (thin && liquidityRisk >= LIQUIDITY_OVERRIDE) {
    classification = "LIQUIDITY";
    confidence = liquidityRisk;
  } else if (liquidityRisk >= 0.75) {
    classification = "LIQUIDITY";
    confidence = liquidityRisk;
  }
  // 2) NEWS: strong news coverage + meaningful info signal
  else if (newsScore >= 0.5 && infoScore >= 0.3) {
    classification = "NEWS";
    confidence = newsScore * 0.6 + infoScore * 0.4;
  }
  // 3) Capital
  else if (capitalScore >= 0.6) {
    classification = "CAPITAL";
    confidence = capitalScore;
  }
  // 4) Info only if we have depth (prevents thin-book mislabels)
  else if (infoScore >= 0.5 && hasInfoDepth) {
    classification = "INFO";
    confidence = infoScore;
  }
  // 5) Price moved but ambiguous:
  //    - if thin, call it LIQUIDITY
  //    - else call it INFO (like before)
  else if (priceScore >= 0.6) {
    if (thin) {
      classification = "LIQUIDITY";
      confidence = Math.max(liquidityRisk, 0.55);
    } else {
      classification = "INFO";
      confidence = priceScore;
    }
  }
  // 6) Time fallback
  else if (timeScore > confidence) {
    classification = "TIME";
    confidence = timeScore;
  }

  // Attach headlines to movement for buildExplanation
  (movement as any).__newsHeadlines = newsHeadlines;

  // Final confidence penalty if market is thin (even if not LIQUIDITY)
  // Keeps signals conservative.
  const adjustedConfidence = clamp01(confidence * (1 - 0.35 * liquidityRisk));

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

  const explanationText = buildExplanation(movement, row);
  const { error: explainErr } = await supabase
    .from("movement_explanations")
    .insert({ movement_id: movement.id, text: explanationText });
  if (explainErr) {
    console.error("[explain] insert failed", explainErr.message, {
      movement_id: movement.id,
    });
    throw explainErr;
  }

  console.log(
    "[signals] inserted",
    row.movement_id,
    row.classification,
    row.confidence.toFixed(3)
  );

  console.log("[signals] inputs", {
    reason,
    drift,
    range,
    volumeRatio: volumeRatioRaw ?? "n/a",
    hourlyRatio: hourlyRatioRaw ?? "n/a",
    tradesCount,
    priceLevels,
    avgTradeSize,
    thin,
  });

  console.log("[signals] scores", {
    priceScore: priceScore.toFixed(3),
    capitalScore: capitalScore.toFixed(3),
    infoScore: infoScore.toFixed(3),
    newsScore: newsScore.toFixed(3),
    timeScore: timeScore.toFixed(3),
    liquidityRisk: liquidityRisk.toFixed(3),
  });

  console.log("[signals] gates", { hasInfoDepth, MIN_INFO_TRADES, MIN_INFO_LEVELS });

  console.log("[explain]", explanationText);

}

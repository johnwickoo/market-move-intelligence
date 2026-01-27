import { supabase } from "../../storage/src/db";
import { buildExplanation } from "../../explanations/src/buildExplanation";

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function safeNum(x: any, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export async function scoreSignals(movement: any) {
  const reason = String(movement.reason ?? "");
  const thin = Boolean(movement.thin_liquidity);

  // PRICE signals
  const drift = Math.abs(safeNum(movement.pct_change, 0));  // e.g. 0.18
  const range = Math.abs(safeNum(movement.range_pct, 0));   // e.g. 0.35

  // VOLUME signals
  const volumeRatio = safeNum(movement.volume_ratio, 0);          // 24h / baselineDaily
  const hourlyRatio = safeNum(movement.hourly_volume_ratio, 0);   // maxHour / baselineHourly

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
   * 5) TIME SCORE (keep minimal for now)
   * You can replace later with “how close to resolution date” etc.
   */
  const timeScore = 0.2;

  /**
   * 6) Classification logic (simple + explainable)
   *
   * - If liquidityRisk is high, classify LIQUIDITY (we don't trust the move)
   * - Else if capitalScore >= 0.6 => CAPITAL
   * - Else if infoScore >= 0.5 => INFO
   * - Else if priceScore >= 0.6 => INFO (price moved but ambiguous)
   * - Else => CAPITAL (default bucket)
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
  // 2) Capital
  else if (capitalScore >= 0.6) {
    classification = "CAPITAL";
    confidence = capitalScore;
  }
  // 3) Info only if we have depth (prevents thin-book mislabels)
  else if (infoScore >= 0.5 && hasInfoDepth) {
    classification = "INFO";
    confidence = infoScore;
  }
  // 4) Price moved but ambiguous:
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
  // 5) Time fallback
  else if (timeScore > confidence) {
    classification = "TIME";
    confidence = timeScore;
  }


  // Final confidence penalty if market is thin (even if not LIQUIDITY)
  // Keeps signals conservative.
  const adjustedConfidence = clamp01(confidence * (1 - 0.35 * liquidityRisk));

  const row = {
    movement_id: movement.id,
    capital_score: capitalScore,
    info_score: infoScore,
    time_score: timeScore,
    classification,
    confidence: adjustedConfidence,
    // Optional: store extra diagnostics if you add columns later
    // price_score: priceScore,
    // liquidity_risk: liquidityRisk,
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
    volumeRatio,
    hourlyRatio,
    tradesCount,
    priceLevels,
    avgTradeSize,
    thin,
  });

  console.log("[signals] scores", {
    priceScore: priceScore.toFixed(3),
    capitalScore: capitalScore.toFixed(3),
    infoScore: infoScore.toFixed(3),
    liquidityRisk: liquidityRisk.toFixed(3),
  });

  console.log("[signals] gates", { hasInfoDepth, MIN_INFO_TRADES, MIN_INFO_LEVELS });

  console.log("[explain]", explanationText);

}

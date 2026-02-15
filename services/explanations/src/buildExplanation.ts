function safeNum(x: any, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export function buildExplanation(movement: any, signal: any): string {
  const pctChange = Math.abs(safeNum(movement?.pct_change, 0));
  const windowStart = Date.parse(movement?.window_start ?? "");
  const windowEnd = Date.parse(movement?.window_end ?? "");
  const windowHours =
    Number.isFinite(windowStart) && Number.isFinite(windowEnd)
      ? Math.max(1, Math.round((windowEnd - windowStart) / (60 * 60 * 1000)))
      : 24;

  const priceSentence = `Price moved ${(pctChange * 100).toFixed(0)}% over ${windowHours}h.`;
  const windowType = String(movement?.window_type ?? "");
  const windowSentence =
    windowType === "event"
      ? "This is a recent move since the last signal."
      : "This is the rolling 24h window.";

  const volumeRatioRaw = movement?.volume_ratio;
  const volumeRatio = safeNum(volumeRatioRaw, 0);
  let volumeSentence = "Volume was near typical levels.";
  if (volumeRatioRaw == null || !Number.isFinite(Number(volumeRatioRaw))) {
    volumeSentence = "Volume baseline is not reliable yet (insufficient history).";
  } else if (volumeRatio < 0.8) {
    volumeSentence = "Volume was below recent average.";
  } else if (volumeRatio > 1.5) {
    volumeSentence = "Volume spiked above normal levels.";
  }

  const thin = Boolean(movement?.thin_liquidity);
  const liquiditySentence = thin
    ? "Orderbook appears thin, so price moves may be exaggerated."
    : "";

  const classification = String(signal?.classification ?? "");
  let classificationSentence = "Move appears driven by market activity.";
  if (classification === "CAPITAL") {
    classificationSentence = "Move appears driven by large capital flows.";
  } else if (classification === "INFO") {
    classificationSentence = "Move appears driven by new information or sentiment.";
  } else if (classification === "LIQUIDITY") {
    classificationSentence = "Liquidity risk is high; thin books can exaggerate moves.";
  } else if (classification === "NEWS") {
    classificationSentence = "Move appears driven by recent news coverage.";
  } else if (classification === "TIME") {
    classificationSentence = "Move may be related to time-to-resolution dynamics.";
  }

  const newsHeadlines: string[] = (movement as any)?.__newsHeadlines ?? [];
  let newsSentence = "";
  if (newsHeadlines.length > 0) {
    const truncated = newsHeadlines
      .slice(0, 2)
      .map((h: string) => (h.length > 80 ? h.slice(0, 77) + "..." : h));
    newsSentence = `Related news: "${truncated.join('"; "')}"`;
  }

  return [priceSentence, windowSentence, volumeSentence, liquiditySentence, classificationSentence, newsSentence]
    .filter(Boolean)
    .join(" ");
}

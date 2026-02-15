function safeNum(x: any, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

const WINDOW_LABELS: Record<string, string> = {
  "5m": "5-minute",
  "15m": "15-minute",
  "1h": "1-hour",
  "4h": "4-hour",
  "event": "since last signal",
  "24h": "24-hour",
};

export function buildExplanation(movement: any, signal: any): string {
  const pctChange = Math.abs(safeNum(movement?.pct_change, 0));
  const windowType = String(movement?.window_type ?? "");
  const windowLabel = WINDOW_LABELS[windowType] ?? windowType;

  const windowStart = Date.parse(movement?.window_start ?? "");
  const windowEnd = Date.parse(movement?.window_end ?? "");
  const windowMinutes =
    Number.isFinite(windowStart) && Number.isFinite(windowEnd)
      ? Math.max(1, Math.round((windowEnd - windowStart) / 60_000))
      : null;

  // Format window duration for display
  let durationStr: string;
  if (windowMinutes != null) {
    if (windowMinutes < 60) durationStr = `${windowMinutes}min`;
    else {
      const h = Math.round(windowMinutes / 60);
      durationStr = `${h}h`;
    }
  } else {
    durationStr = windowLabel;
  }

  const priceSentence = `Price moved ${(pctChange * 100).toFixed(0)}% over ${durationStr}.`;

  const windowSentence =
    windowType === "event"
      ? "This is a recent move since the last signal."
      : windowType === "5m"
        ? "This is a rapid impulse detected in the 5-minute window."
        : windowType === "15m"
          ? "This move was confirmed over 15 minutes."
          : windowType === "1h"
            ? "This is a sustained move over the past hour."
            : windowType === "4h"
              ? "This is a regime-level shift over 4 hours."
              : "This is a rolling detection window.";

  const reason = String(movement?.reason ?? "");
  const velocitySentence =
    reason === "VELOCITY"
      ? "The speed of this move is unusually fast for the time window."
      : "";

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
  } else if (classification === "VELOCITY") {
    classificationSentence = "Move is a rapid impulse — likely catalyst-driven.";
  }

  const newsHeadlines: string[] = (movement as any)?.__newsHeadlines ?? [];
  let newsSentence = "";
  if (newsHeadlines.length > 0) {
    const truncated = newsHeadlines
      .slice(0, 2)
      .map((h: string) => (h.length > 80 ? h.slice(0, 77) + "..." : h));
    newsSentence = `Related news: "${truncated.join('"; "')}"`;
  }

  return [priceSentence, windowSentence, velocitySentence, volumeSentence, liquiditySentence, classificationSentence, newsSentence]
    .filter(Boolean)
    .join(" ");
}

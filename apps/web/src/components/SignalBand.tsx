"use client";

import { createChart, UTCTimestamp } from "lightweight-charts";
import { useEffect, useState } from "react";
import type { Annotation } from "../lib/types";

export function SignalBand({
  signal,
  chart,
  layoutVersion,
  onHover,
}: {
  signal: Annotation;
  chart: ReturnType<typeof createChart> | null;
  layoutVersion: number;
  onHover: (signal: Annotation | null) => void;
}) {
  const [style, setStyle] = useState<{ left: number; width: number } | null>(
    null
  );

  useEffect(() => {
    if (!chart) return;
    const update = () => {
      const timeScale = chart.timeScale();
      const startMs = Date.parse(signal.start_ts);
      const endMs = Date.parse(signal.end_ts);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        setStyle(null);
        return;
      }
      const startTime = Math.floor(startMs / 1000) as UTCTimestamp;
      const endTime = Math.floor(endMs / 1000) as UTCTimestamp;
      let startCoord = timeScale.timeToCoordinate(startTime);
      let endCoord = timeScale.timeToCoordinate(endTime);

      if (startCoord == null || endCoord == null) {
        const range = timeScale.getVisibleRange();
        if (!range) {
          setStyle(null);
          return;
        }
        const clamp = (t: number) =>
          Math.min(Math.max(t, range.from as number), range.to as number);
        const clampedStart = clamp(startTime as number);
        const clampedEnd = clamp(endTime as number);
        startCoord = timeScale.timeToCoordinate(
          clampedStart as UTCTimestamp
        );
        endCoord = timeScale.timeToCoordinate(clampedEnd as UTCTimestamp);
      }
      if (startCoord == null || endCoord == null) {
        setStyle(null);
        return;
      }
      const left = Math.min(startCoord, endCoord);
      const width = Math.max(2, Math.abs(endCoord - startCoord));
      setStyle({ left, width });
    };

    update();
    chart.timeScale().subscribeVisibleTimeRangeChange(update);
    chart.timeScale().subscribeVisibleLogicalRangeChange(update);
    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(update);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(update);
    };
  }, [chart, signal.start_ts, signal.end_ts, layoutVersion]);

  if (!style) return null;

  return (
    <span
      className="signal-band"
      style={{
        left: `${style.left}px`,
        width: `${style.width}px`,
        background: signal.color,
      }}
      onMouseEnter={() => onHover(signal)}
      onMouseLeave={() => onHover(null)}
    />
  );
}

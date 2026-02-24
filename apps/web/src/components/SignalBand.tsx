"use client";

import { createChart, UTCTimestamp } from "lightweight-charts";
import { useEffect, useState } from "react";
import type { Annotation } from "../lib/types";

export const LANE_HEIGHT = 12; // 10px band + 2px gap

export function SignalBand({
  signal,
  chart,
  layoutVersion,
  lane = 0,
  onHover,
}: {
  signal: Annotation;
  chart: ReturnType<typeof createChart> | null;
  layoutVersion: number;
  lane?: number;
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

      const range = timeScale.getVisibleRange();
      if (startCoord == null || endCoord == null) {
        if (!range) {
          setStyle(null);
          return;
        }
        // Hide if signal is completely outside the visible range
        const rangeFrom = range.from as number;
        const rangeTo = range.to as number;
        if (endTime < rangeFrom || startTime > rangeTo) {
          setStyle(null);
          return;
        }
        const clamp = (t: number) =>
          Math.min(Math.max(t, rangeFrom), rangeTo);
        const clampedStart = clamp(startTime as number);
        const clampedEnd = clamp(endTime as number);
        startCoord = timeScale.timeToCoordinate(
          clampedStart as UTCTimestamp
        );
        endCoord = timeScale.timeToCoordinate(clampedEnd as UTCTimestamp);
      }

      if (startCoord != null && endCoord != null) {
        const left = Math.min(startCoord, endCoord);
        const width = Math.max(2, Math.abs(endCoord - startCoord));
        setStyle({ left, width });
        return;
      }

      if (range && Number.isFinite(range.from) && Number.isFinite(range.to)) {
        const chartWidth =
          (chart as any).options()?.width ??
          (chart as any).element()?.clientWidth ??
          0;
        if (chartWidth > 0) {
          const rangeSpan = (range.to as number) - (range.from as number);
          if (rangeSpan > 0) {
            const left =
              ((startTime as number) - (range.from as number)) / rangeSpan *
              chartWidth;
            const width =
              Math.max(
                2,
                ((endTime as number) - (startTime as number)) / rangeSpan *
                  chartWidth
              );
            setStyle({ left, width });
            return;
          }
        }
      }
      setStyle(null);
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
        top: `${lane * LANE_HEIGHT}px`,
        height: "10px",
        background: signal.color,
      }}
      onMouseEnter={() => onHover(signal)}
      onMouseLeave={() => onHover(null)}
    />
  );
}

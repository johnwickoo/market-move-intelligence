"use client";

import { useEffect, useState } from "react";
import type {
  MarketSnapshot,
  OutcomeSeries,
  SeriesPoint,
  VolumePoint,
} from "../lib/types";
import { colorForOutcome } from "../lib/supabase";

const MAX_POINTS = 5000;

type StreamStatus = "offline" | "connecting" | "live" | "reconnecting" | "error";

export function useMarketStream({
  slugs,
  marketIdKey,
  bucketMinutes,
  windowStart,
  useRawTicks,
  pinnedAssetId,
  yesOnly,
  setMarkets,
}: {
  slugs: string;
  marketIdKey: string;
  bucketMinutes: number;
  windowStart: string | null;
  useRawTicks: boolean;
  pinnedAssetId: string;
  yesOnly: boolean;
  setMarkets: React.Dispatch<React.SetStateAction<MarketSnapshot[]>>;
}): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("offline");

  useEffect(() => {
    if (!slugs.trim() || !windowStart) return;
    const streamBase = marketIdKey
      ? `/api/stream?market_id=${encodeURIComponent(marketIdKey)}`
      : `/api/stream?slugs=${encodeURIComponent(slugs)}`;
    const streamUrl =
      `${streamBase}` +
      `&bucketMinutes=${bucketMinutes}` +
      (pinnedAssetId
        ? `&asset_id=${encodeURIComponent(pinnedAssetId)}`
        : "") +
      (yesOnly
        ? `&yesOnly=1${
            slugs.trim() ? `&event_slug=${encodeURIComponent(slugs)}` : ""
          }`
        : "");
    const source = new EventSource(streamUrl);
    setStatus("connecting");

    const pendingTicks: Array<{
      market_id: string;
      outcome: string | null;
      asset_id: string | null;
      ts: string;
      mid: number;
      bucketMinutes: number;
    }> = [];
    const pendingTrades: Array<{
      market_id: string;
      outcome: string | null;
      ts: string;
      size: number;
      side: string | null;
      bucketMinutes: number;
    }> = [];
    const pendingMoves: Array<any> = [];

    const flush = () => {
      if (
        !pendingTicks.length &&
        !pendingTrades.length &&
        !pendingMoves.length
      )
        return;
      setMarkets((prev) => {
        const next = prev.map((m) => ({
          ...m,
          outcomes: m.outcomes.map((o) => ({
            ...o,
            series: [...o.series],
            annotations: [...o.annotations],
            volumes: [...o.volumes],
          })),
        }));
        const marketById = new Map<string, MarketSnapshot>();
        for (const market of next) {
          if (market.market_id) marketById.set(market.market_id, market);
          marketById.set(market.slug, market);
          for (const childId of market.child_market_ids ?? []) {
            marketById.set(childId, market);
          }
        }
        const ensureOutcome = (
          market: MarketSnapshot | null,
          name: string | null,
          marketId?: string | null
        ) => {
          if (!market) return null;
          if (marketId) {
            const byMarketId = market.outcomes.find(
              (o) => o.market_id === marketId
            );
            if (byMarketId) return byMarketId;
          }
          if (!name) return null;
          const existing = market.outcomes.find((o) => o.outcome === name);
          if (existing) return existing;
          const created: OutcomeSeries = {
            outcome: name,
            color: colorForOutcome(name),
            series: [],
            volumes: [],
            annotations: [],
          };
          market.outcomes.push(created);
          return created;
        };
        const baseMs = Date.parse(windowStart);
        if (!Number.isFinite(baseMs)) return prev;

        const addVolumeToSeries = (
          series: SeriesPoint[],
          ts: string,
          size: number
        ) => {
          const tradeMs = Date.parse(ts);
          if (!Number.isFinite(tradeMs) || series.length === 0) return;
          for (let i = series.length - 1; i >= 0; i -= 1) {
            const pointMs = Date.parse(series[i].t);
            if (!Number.isFinite(pointMs)) continue;
            if (pointMs <= tradeMs) {
              series[i].volume += size;
              return;
            }
          }
          series[0].volume += size;
        };
        const bucketMs = Math.max(1, bucketMinutes) * 60 * 1000;
        const toBucketIso = (tsMs: number) => {
          const bucketStart =
            baseMs + Math.floor((tsMs - baseMs) / bucketMs) * bucketMs;
          return new Date(bucketStart).toISOString();
        };

        const upsertBucketPoint = (
          series: SeriesPoint[],
          tsMs: number,
          price: number
        ) => {
          if (!Number.isFinite(tsMs)) return;
          const bucketIso = toBucketIso(tsMs);
          const last = series[series.length - 1];
          if (last && last.t === bucketIso) {
            last.price = price;
            return;
          }
          const existingIndex = series.findIndex((p) => p.t === bucketIso);
          if (existingIndex >= 0) {
            series[existingIndex].price = price;
            return;
          }
          if (last) {
            const lastMs = Date.parse(last.t);
            if (Number.isFinite(lastMs) && tsMs < lastMs) return;
          }
          series.push({ t: bucketIso, price, volume: 0 });
        };

        const upsertVolumeBucket = (
          volumes: VolumePoint[],
          tsMs: number,
          side: string | null,
          size: number
        ) => {
          if (!Number.isFinite(tsMs)) return;
          const bucketIso = toBucketIso(tsMs);
          let bucket: VolumePoint | undefined = volumes[volumes.length - 1];
          if (!bucket || bucket.t !== bucketIso) {
            bucket = volumes.find((v) => v.t === bucketIso);
            if (!bucket) {
              bucket = { t: bucketIso, buy: 0, sell: 0 };
              volumes.push(bucket);
            }
          }
          const normalized = String(side ?? "").toUpperCase();
          if (normalized === "BUY") {
            bucket.buy += size;
          } else if (normalized === "SELL") {
            bucket.sell += size;
          }
        };

        for (const tick of pendingTicks.splice(0)) {
          const market = marketById.get(tick.market_id) ?? null;
          const outcome = ensureOutcome(market, tick.outcome, tick.market_id);
          if (!outcome) continue;
          const tsMs = Date.parse(tick.ts);
          if (!Number.isFinite(tsMs) || tsMs < baseMs) continue;
          if (useRawTicks) {
            const last = outcome.series[outcome.series.length - 1];
            if (last && last.t === tick.ts) {
              last.price = tick.mid;
            } else {
              outcome.series.push({
                t: tick.ts,
                price: tick.mid,
                volume: 0,
              });
            }
          } else {
            upsertBucketPoint(outcome.series, tsMs, tick.mid);
          }
          if (outcome.series.length > MAX_POINTS) {
            outcome.series.splice(0, outcome.series.length - MAX_POINTS);
          }
        }

        for (const tr of pendingTrades.splice(0)) {
          const market = marketById.get(tr.market_id) ?? null;
          const outcome = ensureOutcome(market, tr.outcome, tr.market_id);
          if (!outcome) continue;
          addVolumeToSeries(outcome.series, tr.ts, tr.size);
          const tradeMs = Date.parse(tr.ts);
          if (Number.isFinite(tradeMs)) {
            upsertVolumeBucket(outcome.volumes, tradeMs, tr.side, tr.size);
            if (outcome.volumes.length > MAX_POINTS) {
              outcome.volumes.splice(0, outcome.volumes.length - MAX_POINTS);
            }
          }
        }

        for (const mv of pendingMoves.splice(0)) {
          const marketId = String(mv.market_id ?? "");
          const isEvent = marketId.startsWith("event:");
          const eventSlug = isEvent ? marketId.slice("event:".length) : "";
          const market = isEvent
            ? marketById.get(eventSlug) ?? null
            : marketById.get(marketId) ?? null;
          if (!market) continue;

          const label = isEvent
            ? mv.window_type === "event"
              ? "Event Movement"
              : "Event Window"
            : mv.window_type === "event"
              ? "Movement"
              : "Signal";
          const kind =
            mv.window_type === "event" || isEvent ? "movement" : "signal";
          const color = isEvent
            ? mv.window_type === "event"
              ? "rgba(96, 169, 255, 0.22)"
              : "rgba(96, 169, 255, 0.14)"
            : mv.window_type === "event"
              ? "rgba(80, 220, 140, 0.18)"
              : "rgba(255, 170, 40, 0.18)";

          const applyAnnotation = (outcome: OutcomeSeries) => {
            outcome.annotations.push({
              kind,
              start_ts: mv.window_start,
              end_ts: mv.window_end,
              label,
              explanation: mv.explanation ?? `${label}: ${mv.reason}`,
              color,
            });
          };

          if (isEvent) {
            for (const outcome of market.outcomes) {
              applyAnnotation(outcome);
            }
            continue;
          }

          const outcome = ensureOutcome(market, mv.outcome, mv.market_id);
          if (!outcome) continue;
          applyAnnotation(outcome);
        }

        return next;
      });
    };

    const interval = setInterval(flush, 500);

    source.addEventListener("open", () => setStatus("live"));
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) {
        setStatus("error");
      } else {
        setStatus("reconnecting");
      }
    });
    source.addEventListener("tick", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (
          pinnedAssetId &&
          payload.asset_id &&
          payload.asset_id !== pinnedAssetId
        ) {
          return;
        }
        pendingTicks.push(payload);
      } catch {
        // ignore
      }
    });
    source.addEventListener("trade", (event) => {
      try {
        const payload = JSON.parse(event.data);
        pendingTrades.push({
          ...payload,
          side: payload?.side ?? null,
        });
      } catch {
        // ignore
      }
    });
    source.addEventListener("movement", (event) => {
      try {
        pendingMoves.push(JSON.parse(event.data));
      } catch {
        // ignore
      }
    });

    return () => {
      clearInterval(interval);
      source.close();
    };
  }, [
    slugs,
    marketIdKey,
    bucketMinutes,
    windowStart,
    useRawTicks,
    pinnedAssetId,
    yesOnly,
    setMarkets,
  ]);

  return status;
}

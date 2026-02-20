"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  MarketSnapshot,
  OutcomeSeries,
  SeriesPoint,
  VolumePoint,
} from "../lib/types";
import { colorForOutcome } from "../lib/supabase";

const MAX_POINTS = 5000;

type StreamStatus = "offline" | "connecting" | "live" | "reconnecting" | "error" | "stale";

export function useMarketStream({
  slugs,
  marketIdKey,
  bucketMinutes,
  windowStart,
  useRawTicks,
  pinnedAssetId,
  yesOnly,
  setMarkets,
  streamOutcomesRef,
  setStreamUpdateCounter,
  onMovement,
  onStale,
}: {
  slugs: string;
  marketIdKey: string;
  bucketMinutes: number;
  windowStart: string | null;
  useRawTicks: boolean;
  pinnedAssetId: string;
  yesOnly: boolean;
  setMarkets: React.Dispatch<React.SetStateAction<MarketSnapshot[]>>;
  streamOutcomesRef?: React.MutableRefObject<Map<string, { series: SeriesPoint[]; volumes: VolumePoint[] }> | null>;
  setStreamUpdateCounter?: React.Dispatch<React.SetStateAction<number>>;
  onMovement?: () => void;
  onStale?: () => void;
}): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("offline");
  const onMovementRef = useRef(onMovement);
  onMovementRef.current = onMovement;
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;

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

    // ── Stream diagnostics ──────────────────────────────────────────
    let ticksReceived = 0;
    let ticksFlushed = 0;
    let lastTickReceivedMs = Date.now();
    let emptyFlushes = 0;
    let errorEvents = 0;
    let staleFired = false; // only fire onStale once per stale period
    const streamOpenMs = Date.now();
    const STALE_TIMEOUT_MS = 90_000; // 90s of no ticks before declaring stale
    const diagInterval = setInterval(() => {
      const elapsed = ((Date.now() - streamOpenMs) / 1000).toFixed(0);
      const sinceLast = ((Date.now() - lastTickReceivedMs) / 1000).toFixed(1);
      console.log(
        `[stream:diag] ${elapsed}s alive | received=${ticksReceived} flushed=${ticksFlushed}` +
        ` emptyFlushes=${emptyFlushes} errors=${errorEvents} lastTickAgo=${sinceLast}s staleFired=${staleFired}`
      );
      // Detect stale market: no ticks for 90s after we've received some, fire only once
      if (Date.now() - lastTickReceivedMs > STALE_TIMEOUT_MS && ticksReceived > 0 && !staleFired) {
        staleFired = true;
        console.warn(`[stream:diag] ⚠ NO TICKS for ${sinceLast}s — market likely resolved, triggering refresh`);
        setStatus("stale");
        onStaleRef.current?.();
      }
    }, 15_000);

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
      ) {
        emptyFlushes++;
        return;
      }
      ticksFlushed += pendingTicks.length;
      let committedNext: MarketSnapshot[] | null = null;
      flushSync(() => {
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
        // For binary markets (Yes/No, Up/Down), map complement outcomes
        // to the primary/positive outcome to prevent chart swapping.
        const BINARY_PAIRS: [string, string][] = [["Yes", "No"], ["Up", "Down"]];
        const COMPLEMENT_TO_PRIMARY = new Map<string, string>();
        for (const [primary, complement] of BINARY_PAIRS) {
          COMPLEMENT_TO_PRIMARY.set(complement, primary);
        }

        const resolveBinaryOutcome = (
          market: MarketSnapshot,
          name: string | null
        ): string | null => {
          if (!name) return name;
          if (market.outcomes.length !== 2) return name;
          const labels = market.outcomes.map((o) => o.outcome);
          const primary = COMPLEMENT_TO_PRIMARY.get(name);
          if (primary && labels.includes(primary)) return primary;
          return name;
        };

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
          // Resolve complement outcomes to primary for binary markets
          const resolved = resolveBinaryOutcome(market, name);
          if (!resolved) return null;
          const existing = market.outcomes.find((o) => o.outcome === resolved);
          if (existing) return existing;
          const created: OutcomeSeries = {
            outcome: resolved,
            color: colorForOutcome(resolved),
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

        let upsertDropped = 0;
        let upsertMidHits = 0;
        let upsertPushedCount = 0;
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
            upsertMidHits++;
            if (upsertMidHits <= 3) {
              console.log(
                `[stream:bucket] mid-hit: idx=${existingIndex}/${series.length - 1}` +
                ` bucket=${bucketIso.slice(11, 19)} last=${last?.t.slice(11, 19)}` +
                ` price=${price.toFixed(4)}`
              );
            }
            return;
          }
          if (last) {
            const lastMs = Date.parse(last.t);
            if (Number.isFinite(lastMs) && tsMs < lastMs) {
              upsertDropped++;
              return;
            }
          }
          series.push({ t: bucketIso, price, volume: 0 });
          upsertPushedCount++;
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

        let ticksApplied = 0;
        let ticksNoMarket = 0;
        let ticksNoOutcome = 0;
        let ticksOldTs = 0;
        const allPending = pendingTicks.splice(0);
        for (const tick of allPending) {
          const market = marketById.get(tick.market_id) ?? null;
          if (!market) {
            ticksNoMarket++;
            continue;
          }
          const outcome = ensureOutcome(market, tick.outcome, tick.market_id);
          if (!outcome) {
            ticksNoOutcome++;
            continue;
          }
          const tsMs = Date.parse(tick.ts);
          if (!Number.isFinite(tsMs) || tsMs < baseMs) {
            ticksOldTs++;
            continue;
          }
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
          ticksApplied++;
          if (outcome.series.length > MAX_POINTS) {
            outcome.series.splice(0, outcome.series.length - MAX_POINTS);
          }
        }

        // Log flush diagnostics every ~5s or on drops or mid-hits
        const shouldLogFlush = allPending.length > 0 && (
          ticksNoMarket > 0 || ticksNoOutcome > 0 || ticksOldTs > 0 || upsertDropped > 0 || upsertMidHits > 0 ||
          (ticksFlushed % 100 < allPending.length) // log every ~100 ticks
        );
        if (shouldLogFlush) {
          const lastTick = allPending[allPending.length - 1];
          const outcomeLens = next.flatMap((m) =>
            (m.outcomes ?? []).map((o) => `${m.slug}:${o.outcome}=${o.series.length}`)
          );
          console.log(
            `[stream:flush] pending=${allPending.length} applied=${ticksApplied} pushed=${upsertPushedCount} midHits=${upsertMidHits}` +
            ` dropped(noMarket=${ticksNoMarket} noOutcome=${ticksNoOutcome} oldTs=${ticksOldTs} bucket=${upsertDropped})` +
            ` outcomeSeries=[${outcomeLens.join(", ")}]` +
            ` lastTick: mid=${lastTick?.mid?.toFixed(4)} outcome=${lastTick?.outcome} market=${lastTick?.market_id?.slice(0, 16)} ts=${lastTick?.ts?.slice(11, 23)}`
          );
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

          const wt = String(mv.window_type ?? "");
          const isShortWindow = wt === "event" || wt === "5m" || wt === "15m";
          const label = isEvent
            ? isShortWindow
              ? "Event Movement"
              : `Event Signal (${wt})`
            : isShortWindow
              ? "Movement"
              : `Signal (${wt})`;
          const kind = isShortWindow || isEvent ? "movement" : "signal";
          const color = isEvent
            ? isShortWindow
              ? "rgba(96, 169, 255, 0.22)"
              : "rgba(96, 169, 255, 0.14)"
            : isShortWindow
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

        committedNext = next;
        return next;
      });
      });
      const committed = committedNext as MarketSnapshot[] | null;
      if (committed && streamOutcomesRef?.current) {
        for (const m of committed) {
          for (const o of m.outcomes ?? []) {
            const key = `${m.slug}:${o.outcome}`;
            streamOutcomesRef.current.set(key, {
              series: [...o.series],
              volumes: [...o.volumes],
            });
          }
        }
        setStreamUpdateCounter?.((c) => c + 1);
      }
    };

    const interval = setInterval(flush, 250);

    source.addEventListener("open", () => setStatus("live"));
    source.addEventListener("error", () => {
      errorEvents++;
      if (source.readyState === EventSource.CLOSED) {
        console.error(`[stream:diag] EventSource CLOSED after ${((Date.now() - streamOpenMs) / 1000).toFixed(0)}s`);
        setStatus("error");
      } else {
        console.warn(`[stream:diag] EventSource reconnecting (error #${errorEvents})`);
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
        ticksReceived++;
        lastTickReceivedMs = Date.now();
        if (staleFired) {
          staleFired = false;
          setStatus("live");
        }
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
        onMovementRef.current?.();
      } catch {
        // ignore
      }
    });
    source.addEventListener("rotate", (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log(`[stream] rotate event: server re-resolved to market_ids=${JSON.stringify(data.market_ids)}`);
        // Trigger stale handler to re-fetch historical data for new market
        onStaleRef.current?.();
      } catch {
        // ignore
      }
    });

    return () => {
      clearInterval(interval);
      clearInterval(diagInterval);
      source.close();
      console.log(
        `[stream:diag] cleanup: received=${ticksReceived} flushed=${ticksFlushed}` +
        ` errors=${errorEvents} alive=${((Date.now() - streamOpenMs) / 1000).toFixed(0)}s`
      );
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

"use client";

import { createChart, ColorType } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

type SeriesPoint = {
  t: string;
  price: number;
  volume: number;
};

type VolumePoint = {
  t: string;
  buy: number;
  sell: number;
};

type Annotation = {
  kind: "signal" | "movement";
  startIndex: number;
  endIndex: number;
  label: string;
  explanation: string;
  color: string;
};

type OutcomeSeries = {
  outcome: string;
  color: string;
  series: SeriesPoint[];
  volumes: VolumePoint[];
  annotations: Annotation[];
};

type MarketSnapshot = {
  market_id?: string;
  slug: string;
  title: string;
  outcomes: OutcomeSeries[];
};

const demoMarkets: MarketSnapshot[] = [
  {
    slug: "will-there-be-another-us-government-shutdown-by-january-31",
    title: "US government shutdown Saturday?",
    outcomes: [
      {
        outcome: "Yes",
        color: "#ff6a3d",
        series: [
          { t: "08:00", price: 0.28, volume: 120 },
          { t: "08:30", price: 0.27, volume: 260 },
          { t: "09:00", price: 0.26, volume: 200 },
          { t: "09:30", price: 0.24, volume: 580 },
          { t: "10:00", price: 0.23, volume: 620 },
          { t: "10:30", price: 0.25, volume: 340 },
          { t: "11:00", price: 0.29, volume: 220 },
          { t: "11:30", price: 0.31, volume: 280 },
          { t: "12:00", price: 0.34, volume: 520 },
          { t: "12:30", price: 0.36, volume: 460 },
          { t: "13:00", price: 0.39, volume: 740 },
          { t: "13:30", price: 0.42, volume: 680 },
          { t: "14:00", price: 0.38, volume: 410 },
          { t: "14:30", price: 0.35, volume: 390 },
          { t: "15:00", price: 0.37, volume: 310 },
          { t: "15:30", price: 0.41, volume: 450 },
          { t: "16:00", price: 0.43, volume: 500 },
        ],
        volumes: [],
        annotations: [
          {
            kind: "signal",
            startIndex: 3,
            endIndex: 7,
            label: "Signal",
            explanation:
              "Rolling 24h: price drift crossed the signal threshold with thin liquidity.",
            color: "rgba(255, 170, 40, 0.14)",
          },
          {
            kind: "movement",
            startIndex: 8,
            endIndex: 12,
            label: "Movement",
            explanation:
              "Recent move since last signal: price held above the confirm band.",
            color: "rgba(80, 220, 140, 0.14)",
          },
        ],
      },
      {
        outcome: "No",
        color: "#3a6bff",
        series: [
          { t: "08:00", price: 0.72, volume: 180 },
          { t: "08:30", price: 0.73, volume: 320 },
          { t: "09:00", price: 0.74, volume: 240 },
          { t: "09:30", price: 0.76, volume: 430 },
          { t: "10:00", price: 0.77, volume: 580 },
          { t: "10:30", price: 0.75, volume: 310 },
          { t: "11:00", price: 0.71, volume: 290 },
          { t: "11:30", price: 0.69, volume: 260 },
          { t: "12:00", price: 0.66, volume: 420 },
          { t: "12:30", price: 0.64, volume: 380 },
          { t: "13:00", price: 0.61, volume: 600 },
          { t: "13:30", price: 0.58, volume: 720 },
          { t: "14:00", price: 0.62, volume: 410 },
          { t: "14:30", price: 0.65, volume: 360 },
          { t: "15:00", price: 0.63, volume: 280 },
          { t: "15:30", price: 0.59, volume: 420 },
          { t: "16:00", price: 0.57, volume: 460 },
        ],
        volumes: [],
        annotations: [
          {
            kind: "signal",
            startIndex: 2,
            endIndex: 5,
            label: "Signal",
            explanation:
              "Rolling 24h: volume spike paired with a tight spread.",
            color: "rgba(255, 170, 40, 0.14)",
          },
          {
            kind: "movement",
            startIndex: 10,
            endIndex: 13,
            label: "Movement",
            explanation:
              "Recent move since last signal: sustained sell pressure.",
            color: "rgba(80, 220, 140, 0.14)",
          },
        ],
      },
    ],
  },
];

const DEFAULT_BUCKET_MINUTES = 1;
const MAX_POINTS = 5000;
const ESTIMATED_TICK_MS = 2000;
const DEFAULT_SINCE_HOURS = Math.max(
  1,
  Math.round((MAX_POINTS * ESTIMATED_TICK_MS) / 3_600_000)
);

function inferBucketMinutes(_slugs: string) {
  return DEFAULT_BUCKET_MINUTES;
}

function inferSinceHours(slugs: string, bucketMinutes: number) {
  if (bucketMinutes <= 1) return DEFAULT_SINCE_HOURS;
  const parts = slugs
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.some((s) => s.includes("-15m-") || s.includes("15m"))) return 6;
  return 24;
}

function colorForOutcome(label: string) {
  const normalized = label.trim().toLowerCase();
  if (normalized === "yes" || normalized === "up") return "#ff6a3d";
  if (normalized === "no" || normalized === "down") return "#3a6bff";
  return "#9aa3b8";
}


export default function Page() {
  const [markets, setMarkets] = useState<MarketSnapshot[]>(demoMarkets);
  const slugs =
    process.env.NEXT_PUBLIC_TRACKED_SLUG ??
    "bitcoin-above-on-february-2";
  const inferredBucketMinutes = useMemo(() => inferBucketMinutes(slugs), [slugs]);
  const inferredSinceHours = useMemo(
    () => inferSinceHours(slugs, inferredBucketMinutes),
    [slugs, inferredBucketMinutes]
  );
  const [chartMode, setChartMode] = useState<"raw" | "1m">("raw");
  const useRawTicks = chartMode === "raw";
  const [bucketMinutes, setBucketMinutes] = useState(inferredBucketMinutes);
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState("offline");
  const [lastPrice, setLastPrice] = useState(0);
  const [rangePct, setRangePct] = useState(0);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const lineSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const pointsRef = useRef<Array<{ time: number; value: number }>>([]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/markets?slugs=${encodeURIComponent(slugs)}` +
            `&sinceHours=${inferredSinceHours}` +
            `&bucketMinutes=${inferredBucketMinutes}` +
            `&raw=${useRawTicks ? "1" : "0"}`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = await res.json();
        if (!active) return;
        if (Array.isArray(json.markets) && json.markets.length > 0) {
          const normalized = json.markets.map((m: MarketSnapshot) => ({
            ...m,
            outcomes: (m.outcomes ?? []).map((o: OutcomeSeries) => ({
              ...o,
              volumes: o.volumes ?? [],
            })),
          }));
          setMarkets(normalized);
        }
        if (json.bucketMinutes && Number(json.bucketMinutes) > 0) {
          setBucketMinutes(Number(json.bucketMinutes));
        } else {
          setBucketMinutes(inferredBucketMinutes);
        }
        if (json.windowStart) {
          setWindowStart(String(json.windowStart));
        }
      } catch (err: any) {
        if (active) setError(err?.message ?? "Failed to load");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [slugs, inferredSinceHours, inferredBucketMinutes, useRawTicks]);

  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container || chartRef.current) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "#0b0f1a" },
        textColor: "#c7d0e0",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.06)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "rgba(255,255,255,0.08)",
      },
    });

    const lineSeries = chart.addLineSeries({
      color: "#4f7cff",
      lineWidth: 2,
    });

    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: "#2ecc71",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    lineSeriesRef.current = lineSeries;
    volumeSeriesRef.current = volumeSeries;

    const resize = () => {
      chart.applyOptions({
        width: container.clientWidth,
        height: 320,
      });
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      lineSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  const [slug, setSlug] = useState(demoMarkets[0].slug);
  useEffect(() => {
    if (!markets.find((m) => m.slug === slug) && markets.length > 0) {
      setSlug(markets[0].slug);
    }
  }, [markets, slug]);

  const selectedMarket = useMemo(
    () => markets.find((m) => m.slug === slug) ?? markets[0],
    [slug, markets]
  );

  const dominantOutcome = useMemo(() => {
    if (!selectedMarket?.outcomes?.length) return null;
    let best = selectedMarket.outcomes[0];
    let bestVolume = -1;
    for (const o of selectedMarket.outcomes) {
      const total = (o.volumes ?? []).reduce(
        (sum, v) => sum + Number(v.buy ?? 0) + Number(v.sell ?? 0),
        0
      );
      if (total > bestVolume) {
        best = o;
        bestVolume = total;
      }
    }
    return best.outcome;
  }, [selectedMarket]);

  const marketIdKey = useMemo(() => {
    return markets
      .map((m) => m.market_id)
      .filter((m): m is string => !!m)
      .join(",");
  }, [markets]);

  useEffect(() => {
    if (!slugs.trim() || !windowStart) return;
    const streamUrl = marketIdKey
      ? `/api/stream?market_id=${encodeURIComponent(marketIdKey)}&bucketMinutes=${bucketMinutes}`
      : `/api/stream?slugs=${encodeURIComponent(slugs)}&bucketMinutes=${bucketMinutes}`;
    const source = new EventSource(streamUrl);
    setStreamStatus("connecting");

    const pendingTicks: Array<{
      market_id: string;
      outcome: string | null;
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
      if (!pendingTicks.length && !pendingTrades.length && !pendingMoves.length) return;
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
        const marketById = (id: string) =>
          next.find((m) => m.market_id === id || m.slug === id) ?? next[0];
        const ensureOutcome = (market: MarketSnapshot, name: string | null) => {
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
        const indexForTs = (series: SeriesPoint[], ts: string) => {
          if (series.length === 0) return 0;
          const targetMs = Date.parse(ts);
          if (!Number.isFinite(targetMs)) return 0;
          const firstMs = Date.parse(series[0].t);
          const lastMs = Date.parse(series[series.length - 1].t);
          if (Number.isFinite(firstMs) && targetMs <= firstMs) return 0;
          if (Number.isFinite(lastMs) && targetMs >= lastMs) return series.length - 1;
          for (let i = 0; i < series.length; i += 1) {
            const pointMs = Date.parse(series[i].t);
            if (!Number.isFinite(pointMs)) continue;
            if (pointMs >= targetMs) return i;
          }
          return series.length - 1;
        };

        const bucketMs = Math.max(1, bucketMinutes) * 60 * 1000;
        const toBucketIso = (tsMs: number) => {
          const bucketStart = baseMs + Math.floor((tsMs - baseMs) / bucketMs) * bucketMs;
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
          let bucket = volumes[volumes.length - 1];
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
          const market = marketById(tick.market_id);
          const outcome = ensureOutcome(market, tick.outcome);
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
          const market = marketById(tr.market_id);
          const outcome = ensureOutcome(market, tr.outcome);
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
          const market = marketById(mv.market_id);
          const outcome = ensureOutcome(market, mv.outcome);
          if (!outcome) continue;
          const startIndex = indexForTs(outcome.series, mv.window_start);
          const endIndex = indexForTs(outcome.series, mv.window_end);
          const label = mv.window_type === "event" ? "Movement" : "Signal";
          outcome.annotations.push({
            kind: mv.window_type === "event" ? "movement" : "signal",
            startIndex,
            endIndex,
            label,
            explanation: mv.explanation ?? `${label}: ${mv.reason}`,
            color:
              mv.window_type === "event"
                ? "rgba(80, 220, 140, 0.18)"
                : "rgba(255, 170, 40, 0.18)",
          });
        }

        return next;
      });
    };

    const interval = setInterval(flush, 500);

    source.addEventListener("open", () => setStreamStatus("live"));
    source.addEventListener("error", () => setStreamStatus("reconnecting"));
    source.addEventListener("tick", (event) => {
      try {
        const payload = JSON.parse(event.data);
        console.log("[sse] tick", payload);
        pendingTicks.push(payload);
      } catch {
        // ignore
      }
    });
    source.addEventListener("trade", (event) => {
      try {
        const payload = JSON.parse(event.data);
        console.log("[sse] trade", payload);
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
        const payload = JSON.parse(event.data);
        console.log("[sse] movement", payload);
        pendingMoves.push(payload);
      } catch {
        // ignore
      }
    });

    return () => {
      clearInterval(interval);
      source.close();
    };
  }, [slugs, marketIdKey, bucketMinutes, windowStart, useRawTicks]);

  const [outcome, setOutcome] = useState(selectedMarket.outcomes[0].outcome);

  useEffect(() => {
    if (!dominantOutcome) return;
    setOutcome(dominantOutcome);
  }, [dominantOutcome]);

  const selectedOutcome = useMemo(() => {
    return (
      selectedMarket.outcomes.find((o) => o.outcome === outcome) ??
      selectedMarket.outcomes[0]
    );
  }, [selectedMarket, outcome]);

  useEffect(() => {
    const seriesApi = lineSeriesRef.current;
    if (!seriesApi) return;
    const points = selectedOutcome.series
      .map((p) => {
        const ts = Date.parse(p.t);
        if (!Number.isFinite(ts)) return null;
        return { time: Math.floor(ts / 1000), value: p.price };
      })
      .filter((p): p is { time: number; value: number } => !!p)
      .sort((a, b) => a.time - b.time);

    const deduped: Array<{ time: number; value: number }> = [];
    for (const point of points) {
      const last = deduped[deduped.length - 1];
      if (last && last.time === point.time) {
        last.value = point.value;
      } else {
        deduped.push(point);
      }
    }

    const trimmed = deduped.slice(-MAX_POINTS);
    pointsRef.current = trimmed;
    seriesApi.setData(trimmed);
    seriesApi.applyOptions({ color: selectedOutcome.color });

    const volumeApi = volumeSeriesRef.current;
    if (volumeApi) {
      const volumePoints = selectedOutcome.volumes
        .map((v) => {
          const ts = Date.parse(v.t);
          if (!Number.isFinite(ts)) return null;
          const buy = Number(v.buy ?? 0);
          const sell = Number(v.sell ?? 0);
          const total = buy + sell;
          const delta = buy - sell;
          const color =
            delta > 0
              ? "#2ecc71"
              : delta < 0
                ? "#e74c3c"
                : "rgba(200,200,200,0.6)";
          return {
            time: Math.floor(ts / 1000),
            value: total,
            color,
          };
        })
        .filter((p): p is { time: number; value: number; color: string } => !!p)
        .sort((a, b) => a.time - b.time);

      const dedupedVolumes: Array<{ time: number; value: number; color: string }> = [];
      for (const point of volumePoints) {
        const last = dedupedVolumes[dedupedVolumes.length - 1];
        if (last && last.time === point.time) {
          last.value = point.value;
          last.color = point.color;
        } else {
          dedupedVolumes.push(point);
        }
      }

      volumeApi.setData(dedupedVolumes.slice(-MAX_POINTS));
    }

    if (trimmed.length > 0) {
      const values = trimmed.map((p) => p.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const last = trimmed[trimmed.length - 1]?.value ?? 0;
      const range = Math.max(0.0001, max - min);
      const pct = (range / Math.max(0.0001, max)) * 100;
      setLastPrice(last);
      setRangePct(pct);
    }
  }, [selectedOutcome]);

  const chartWindowLabel = `${useRawTicks ? "Raw ticks" : "1m buckets"} · ${inferredSinceHours}h`;

  return (
    <main className="mmi-shell">
      <header className="mmi-topbar">
        <div>
          <p className="eyebrow">Market Move Intelligence</p>
          <h1>Live market tape</h1>
          <p className="lede">
            Single-market charting for QA. Price curve rendered from mid ticks.
          </p>
        </div>
        <div className="status-pill" data-state={streamStatus}>
          {loading ? "Loading" : streamStatus}
          {error ? ` · ${error}` : ""}
        </div>
      </header>

      <section className="mmi-panel">
        <div className="panel-header">
          <div>
            <p className="market-title">{selectedMarket.title}</p>
            <p className="market-slug">{selectedMarket.slug}</p>
          </div>
          <div className="panel-metrics">
            <div>
              <span>Last</span>
              <strong>{lastPrice.toFixed(3)}</strong>
            </div>
            <div>
              <span>Window range</span>
              <strong>{rangePct.toFixed(1)}%</strong>
            </div>
            {selectedMarket.outcomes.length > 1 && (
              <div className="dominant-pill">
                Dominant: {selectedOutcome.outcome}
              </div>
            )}
            <div className="mode-tabs">
              <button
                type="button"
                className={useRawTicks ? "active" : ""}
                onClick={() => setChartMode("raw")}
              >
                Raw ticks
              </button>
              <button
                type="button"
                className={!useRawTicks ? "active" : ""}
                onClick={() => setChartMode("1m")}
              >
                1m buckets
              </button>
            </div>
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-stage">
            <div ref={chartContainerRef} className="lw-chart" />
          </div>
          <div className="axis-note">{chartWindowLabel}</div>
        </div>
      </section>

      <style jsx global>{`
        @import url("https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=DM+Serif+Display&display=swap");
        :root {
          --bg-0: #0b0d12;
          --bg-1: #121827;
          --panel: #151b2a;
          --panel-2: #0f1524;
          --ink: #f8f5f2;
          --muted: #9aa3b8;
          --accent: #ff7847;
          --accent-2: #21c58f;
          --grid: rgba(255, 255, 255, 0.06);
        }
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          font-family: "Sora", sans-serif;
          background: radial-gradient(circle at 15% 20%, #1c2336 0%, #0b0d12 60%)
            fixed;
          color: var(--ink);
        }
        body::before {
          content: "";
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
            linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px);
          background-size: 64px 64px;
          opacity: 0.35;
          pointer-events: none;
          z-index: 0;
        }
        .mmi-shell {
          position: relative;
          z-index: 1;
          min-height: 100vh;
          padding: 56px clamp(20px, 4vw, 72px) 80px;
          display: grid;
          gap: 32px;
        }
        .mmi-topbar {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 24px;
          animation: fadeUp 0.7s ease both;
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.28em;
          font-size: 11px;
          color: var(--muted);
          margin: 0 0 12px;
        }
        h1 {
          font-family: "DM Serif Display", serif;
          font-size: clamp(36px, 5vw, 56px);
          margin: 0 0 12px;
        }
        .lede {
          margin: 0;
          color: var(--muted);
          line-height: 1.6;
          max-width: 520px;
        }
        .status-pill {
          padding: 10px 16px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: var(--muted);
          background: rgba(16, 20, 34, 0.8);
        }
        .mmi-panel {
          background: linear-gradient(145deg, rgba(21, 27, 42, 0.95), rgba(12, 16, 28, 0.95));
          border-radius: 28px;
          padding: 28px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 30px 70px rgba(0, 0, 0, 0.45);
          animation: fadeUp 0.8s ease both;
        }
        .panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 24px;
          flex-wrap: wrap;
          margin-bottom: 20px;
        }
        .market-title {
          font-size: 20px;
          margin: 0;
        }
        .market-slug {
          margin: 6px 0 0;
          color: var(--muted);
          font-size: 12px;
        }
        .panel-metrics {
          display: flex;
          gap: 16px;
          align-items: center;
          flex-wrap: wrap;
        }
        .panel-metrics div {
          background: rgba(8, 10, 16, 0.5);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 10px 14px;
          min-width: 110px;
        }
        .panel-metrics span {
          display: block;
          font-size: 10px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .panel-metrics strong {
          font-size: 16px;
          font-weight: 600;
        }
        .dominant-pill {
          padding: 6px 12px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(10, 14, 25, 0.7);
          color: var(--ink);
          font-size: 12px;
        }
        .mode-tabs {
          display: flex;
          gap: 6px;
          padding: 4px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(10, 14, 25, 0.7);
        }
        .mode-tabs button {
          border: none;
          background: transparent;
          color: var(--muted);
          padding: 6px 12px;
          border-radius: 999px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .mode-tabs button.active {
          background: rgba(255, 255, 255, 0.08);
          color: var(--ink);
        }
        .chart-card {
          background: linear-gradient(160deg, rgba(12, 17, 30, 0.85), rgba(9, 12, 22, 0.95));
          border-radius: 22px;
          padding: 20px 18px 16px;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .chart-stage {
          position: relative;
          border-radius: 18px;
          padding: 12px 12px 10px;
          background: linear-gradient(180deg, rgba(18, 22, 34, 0.9), rgba(10, 14, 24, 0.95));
          overflow: hidden;
        }
        .lw-chart {
          width: 100%;
          height: 320px;
        }
        .axis-note {
          margin-top: 10px;
          font-size: 11px;
          color: var(--muted);
          text-align: right;
        }
        @keyframes fadeUp {
          from {
            opacity: 0;
            transform: translateY(18px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @media (max-width: 900px) {
          .mmi-topbar {
            flex-direction: column;
          }
          .chart-grid {
            grid-template-columns: 1fr;
          }
          .y-axis {
            flex-direction: row;
            justify-content: space-between;
            padding: 0 0 8px;
          }
        }
      `}</style>
    </main>
  );
}

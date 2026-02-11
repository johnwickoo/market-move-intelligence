"use client";

import { createChart, ColorType } from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Annotation,
  MarketSnapshot,
  OutcomeSeries,
  PinnedSelection,
} from "../lib/types";
import { SignalBand } from "../components/SignalBand";
import { useMarketStream } from "../hooks/useMarketStream";

// ── constants ───────────────────────────────────────────────────────

const DEFAULT_BUCKET_MINUTES = 1;
const MAX_POINTS = 5000;
const ESTIMATED_TICK_MS = 2000;
const DEFAULT_SINCE_HOURS = Math.max(
  1,
  Math.round((MAX_POINTS * ESTIMATED_TICK_MS) / 3_600_000)
);
const SLUG_STORAGE_KEY = "mmi:tracked-slug";
const ENV_DEFAULT_SLUG = process.env.NEXT_PUBLIC_TRACKED_SLUG ?? "";

// ── demo data ───────────────────────────────────────────────────────

function makeDemoTs(hour: number, min: number): string {
  const d = new Date();
  d.setUTCHours(hour, min, 0, 0);
  return d.toISOString();
}

const demoMarkets: MarketSnapshot[] = [
  {
    slug: "will-there-be-another-us-government-shutdown-by-january-31",
    title: "US government shutdown Saturday?",
    outcomes: [
      {
        outcome: "Yes",
        color: "#ff6a3d",
        series: [
          { t: makeDemoTs(8, 0), price: 0.28, volume: 120 },
          { t: makeDemoTs(8, 30), price: 0.27, volume: 260 },
          { t: makeDemoTs(9, 0), price: 0.26, volume: 200 },
          { t: makeDemoTs(9, 30), price: 0.24, volume: 580 },
          { t: makeDemoTs(10, 0), price: 0.23, volume: 620 },
          { t: makeDemoTs(10, 30), price: 0.25, volume: 340 },
          { t: makeDemoTs(11, 0), price: 0.29, volume: 220 },
          { t: makeDemoTs(11, 30), price: 0.31, volume: 280 },
          { t: makeDemoTs(12, 0), price: 0.34, volume: 520 },
          { t: makeDemoTs(12, 30), price: 0.36, volume: 460 },
          { t: makeDemoTs(13, 0), price: 0.39, volume: 740 },
          { t: makeDemoTs(13, 30), price: 0.42, volume: 680 },
          { t: makeDemoTs(14, 0), price: 0.38, volume: 410 },
          { t: makeDemoTs(14, 30), price: 0.35, volume: 390 },
          { t: makeDemoTs(15, 0), price: 0.37, volume: 310 },
          { t: makeDemoTs(15, 30), price: 0.41, volume: 450 },
          { t: makeDemoTs(16, 0), price: 0.43, volume: 500 },
        ],
        volumes: [],
        annotations: [
          {
            kind: "signal",
            start_ts: makeDemoTs(9, 30),
            end_ts: makeDemoTs(11, 30),
            label: "Signal",
            explanation:
              "Rolling 24h: price drift crossed the signal threshold with thin liquidity.",
            color: "rgba(255, 170, 40, 0.14)",
          },
          {
            kind: "movement",
            start_ts: makeDemoTs(12, 0),
            end_ts: makeDemoTs(14, 0),
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
          { t: makeDemoTs(8, 0), price: 0.72, volume: 180 },
          { t: makeDemoTs(8, 30), price: 0.73, volume: 320 },
          { t: makeDemoTs(9, 0), price: 0.74, volume: 240 },
          { t: makeDemoTs(9, 30), price: 0.76, volume: 430 },
          { t: makeDemoTs(10, 0), price: 0.77, volume: 580 },
          { t: makeDemoTs(10, 30), price: 0.75, volume: 310 },
          { t: makeDemoTs(11, 0), price: 0.71, volume: 290 },
          { t: makeDemoTs(11, 30), price: 0.69, volume: 260 },
          { t: makeDemoTs(12, 0), price: 0.66, volume: 420 },
          { t: makeDemoTs(12, 30), price: 0.64, volume: 380 },
          { t: makeDemoTs(13, 0), price: 0.61, volume: 600 },
          { t: makeDemoTs(13, 30), price: 0.58, volume: 720 },
          { t: makeDemoTs(14, 0), price: 0.62, volume: 410 },
          { t: makeDemoTs(14, 30), price: 0.65, volume: 360 },
          { t: makeDemoTs(15, 0), price: 0.63, volume: 280 },
          { t: makeDemoTs(15, 30), price: 0.59, volume: 420 },
          { t: makeDemoTs(16, 0), price: 0.57, volume: 460 },
        ],
        volumes: [],
        annotations: [
          {
            kind: "signal",
            start_ts: makeDemoTs(9, 0),
            end_ts: makeDemoTs(10, 30),
            label: "Signal",
            explanation:
              "Rolling 24h: volume spike paired with a tight spread.",
            color: "rgba(255, 170, 40, 0.14)",
          },
          {
            kind: "movement",
            start_ts: makeDemoTs(13, 0),
            end_ts: makeDemoTs(14, 30),
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

// ── helpers ─────────────────────────────────────────────────────────

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

// ── page component ──────────────────────────────────────────────────

export default function Page() {
  const [markets, setMarkets] = useState<MarketSnapshot[]>(demoMarkets);
  const [slugs, setSlugs] = useState(ENV_DEFAULT_SLUG);
  const [slugInput, setSlugInput] = useState(ENV_DEFAULT_SLUG);
  const [pinned, setPinned] = useState<PinnedSelection>({
    marketId: "",
    assetId: "",
  });
  const inferredBucketMinutes = useMemo(
    () => inferBucketMinutes(slugs),
    [slugs]
  );
  const inferredSinceHours = useMemo(
    () => inferSinceHours(slugs, inferredBucketMinutes),
    [slugs, inferredBucketMinutes]
  );

  // Resolve slug from URL → localStorage → env default (once on mount)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlSlug = (params.get("slug") ?? params.get("slugs") ?? "").trim();
    const urlMarket = (
      params.get("market_id") ?? params.get("marketId") ?? ""
    ).trim();
    const urlAsset = (
      params.get("asset_id") ?? params.get("assetId") ?? ""
    ).trim();

    if (urlMarket) {
      setPinned({ marketId: urlMarket, assetId: urlAsset });
    }

    const resolved =
      urlSlug ||
      localStorage.getItem(SLUG_STORAGE_KEY) ||
      ENV_DEFAULT_SLUG;

    if (resolved) {
      setSlugs(resolved);
      setSlugInput(resolved);
      localStorage.setItem(SLUG_STORAGE_KEY, resolved);
    }
  }, []);

  const [chartMode, setChartMode] = useState<"raw" | "1m">("raw");
  const useRawTicks = chartMode === "raw";
  const [bucketMinutes, setBucketMinutes] = useState(inferredBucketMinutes);
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPrice, setLastPrice] = useState(0);
  const [rangePct, setRangePct] = useState(0);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const lineSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const [signalWindows, setSignalWindows] = useState<Annotation[]>([]);
  const [hoveredSignal, setHoveredSignal] = useState<Annotation | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const [signalLayoutTick, setSignalLayoutTick] = useState(0);

  // ── slug submission handler ──────────────────────────────────────

  const applySlug = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === slugs) return;
    setSlugs(trimmed);
    setSlugInput(trimmed);
    localStorage.setItem(SLUG_STORAGE_KEY, trimmed);
    const url = new URL(window.location.href);
    url.searchParams.set("slug", trimmed);
    url.searchParams.delete("market_id");
    url.searchParams.delete("marketId");
    url.searchParams.delete("asset_id");
    url.searchParams.delete("assetId");
    window.history.replaceState({}, "", url.toString());
    setPinned({ marketId: "", assetId: "" });
    // Register slug for ingestion (fire-and-forget)
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: trimmed }),
    }).catch(() => {});
  };

  // ── fetch initial market data ─────────────────────────────────────

  useEffect(() => {
    if (!slugs && !pinned.marketId) return; // nothing to fetch yet
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const base = pinned.marketId
          ? `/api/markets?market_id=${encodeURIComponent(pinned.marketId)}`
          : `/api/markets?slugs=${encodeURIComponent(slugs)}`;
        const res = await fetch(
          `${base}` +
            `&sinceHours=${inferredSinceHours}` +
            `&bucketMinutes=${inferredBucketMinutes}` +
            `&raw=${useRawTicks ? "1" : "0"}` +
            (pinned.assetId
              ? `&asset_id=${encodeURIComponent(pinned.assetId)}`
              : ""),
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
  }, [slugs, inferredSinceHours, inferredBucketMinutes, useRawTicks, pinned]);

  // ── chart setup ───────────────────────────────────────────────────

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
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "rgba(255,255,255,0.08)",
        tickMarkFormatter: (ts: number) => {
          const d = new Date(ts * 1000);
          return d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
        },
      },
      localization: {
        timeFormatter: (ts: number) => {
          const d = new Date(ts * 1000);
          return d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        },
      },
    });

    const lineSeries = chart.addLineSeries({
      color: "#4f7cff",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 3, minMove: 0.001 },
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
    setChartReady(true);

    const resize = () => {
      chart.applyOptions({ width: container.clientWidth, height: 320 });
      setSignalLayoutTick((v) => v + 1);
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
      setChartReady(false);
    };
  }, []);

  // ── market / outcome selection ────────────────────────────────────

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

  // Prefer "Yes" if it exists; otherwise pick the outcome with most volume.
  // This is computed once per market selection — subsequent updates won't flip it.
  const dominantOutcome = useMemo(() => {
    if (!selectedMarket?.outcomes?.length) return null;
    const yes = selectedMarket.outcomes.find(
      (o) => o.outcome.toLowerCase() === "yes"
    );
    if (yes) return yes.outcome;
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
    if (pinned.marketId) return pinned.marketId;
    return markets
      .map((m) => m.market_id)
      .filter((m): m is string => !!m)
      .join(",");
  }, [markets, pinned.marketId]);

  // ── SSE stream (extracted hook) ───────────────────────────────────

  const streamStatus = useMarketStream({
    slugs,
    marketIdKey,
    bucketMinutes,
    windowStart,
    useRawTicks,
    pinnedAssetId: pinned.assetId,
    setMarkets,
  });

  const [outcome, setOutcome] = useState(selectedMarket.outcomes[0].outcome);
  const outcomeLocked = useRef(false);

  // Set outcome once on initial load or market change, then lock it
  useEffect(() => {
    if (!dominantOutcome) return;
    if (outcomeLocked.current) return;
    setOutcome(dominantOutcome);
    outcomeLocked.current = true;
  }, [dominantOutcome]);

  // Unlock when slug changes (new market loaded)
  useEffect(() => {
    outcomeLocked.current = false;
  }, [slugs]);

  const selectedOutcome = useMemo(() => {
    return (
      selectedMarket.outcomes.find((o) => o.outcome === outcome) ??
      selectedMarket.outcomes[0]
    );
  }, [selectedMarket, outcome]);

  useEffect(() => {
    setSignalWindows(selectedOutcome.annotations ?? []);
    setHoveredSignal(null);
  }, [selectedOutcome]);

  // ── sync chart data ───────────────────────────────────────────────

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

    // Forward-fill: extend line to "now" using last known price
    const nowSec = Math.floor(Date.now() / 1000);
    const lastPoint = deduped[deduped.length - 1];
    if (lastPoint && nowSec - lastPoint.time > 10) {
      deduped.push({ time: nowSec, value: lastPoint.value });
    }

    const trimmed = deduped.slice(-MAX_POINTS);
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
          return { time: Math.floor(ts / 1000), value: total, color };
        })
        .filter(
          (p): p is { time: number; value: number; color: string } => !!p
        )
        .sort((a, b) => a.time - b.time);

      const dedupedVol: Array<{
        time: number;
        value: number;
        color: string;
      }> = [];
      for (const point of volumePoints) {
        const last = dedupedVol[dedupedVol.length - 1];
        if (last && last.time === point.time) {
          last.value = point.value;
          last.color = point.color;
        } else {
          dedupedVol.push(point);
        }
      }

      volumeApi.setData(dedupedVol.slice(-MAX_POINTS));
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

  // ── render ────────────────────────────────────────────────────────

  return (
    <main className="mmi-shell">
      <header className="mmi-topbar">
        <div>
          <p className="eyebrow">Market Move Intelligence</p>
          <h1>Live market tape</h1>
          <form
            className="slug-form"
            onSubmit={(e) => {
              e.preventDefault();
              applySlug(slugInput);
            }}
          >
            <input
              type="text"
              className="slug-input"
              value={slugInput}
              onChange={(e) => setSlugInput(e.target.value)}
              placeholder="Enter market slug…"
              spellCheck={false}
            />
            <button type="submit" className="slug-go">
              Load
            </button>
          </form>
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
            <div className="metric">
              <span>Last</span>
              <strong>{lastPrice.toFixed(3)}</strong>
            </div>
            <div className="metric">
              <span>Window range</span>
              <strong>{rangePct.toFixed(1)}%</strong>
            </div>
            {selectedMarket.outcomes.length > 1 && (
              <div className="dominant-pill">
                Dominant: {selectedOutcome.outcome}
              </div>
            )}
            {pinned.marketId && (
              <div className="dominant-pill">
                Pinned: {pinned.marketId.slice(0, 8)}…
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
            <div className="signal-strip">
              {signalWindows.map((signal, idx) => (
                <SignalBand
                  key={`${signal.kind}-${signal.start_ts}-${idx}`}
                  signal={signal}
                  chart={chartReady ? chartRef.current : null}
                  layoutVersion={signalLayoutTick}
                  onHover={setHoveredSignal}
                />
              ))}
            </div>
            {hoveredSignal && (
              <div className="signal-tooltip">
                <div className="signal-title">{hoveredSignal.label}</div>
                <div className="signal-window">
                  {new Date(hoveredSignal.start_ts).toLocaleString()} →{" "}
                  {new Date(hoveredSignal.end_ts).toLocaleString()}
                </div>
                <div className="signal-text">{hoveredSignal.explanation}</div>
              </div>
            )}
          </div>
          <div className="axis-note">{chartWindowLabel}</div>
        </div>
      </section>

      {/* @ts-expect-error styled-jsx */}
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
          background: radial-gradient(
              circle at 15% 20%,
              #1c2336 0%,
              #0b0d12 60%
            )
            fixed;
          color: var(--ink);
        }
        body::before {
          content: "";
          position: fixed;
          inset: 0;
          background-image: linear-gradient(
              90deg,
              rgba(255, 255, 255, 0.03) 1px,
              transparent 1px
            ),
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
        .slug-form {
          display: flex;
          gap: 8px;
          margin-top: 14px;
          max-width: 560px;
        }
        .slug-input {
          flex: 1;
          background: rgba(8, 10, 16, 0.6);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 10px 14px;
          font-family: "Sora", sans-serif;
          font-size: 13px;
          color: var(--ink);
          outline: none;
          transition: border-color 0.2s;
        }
        .slug-input:focus {
          border-color: rgba(79, 124, 255, 0.5);
        }
        .slug-input::placeholder {
          color: var(--muted);
          opacity: 0.6;
        }
        .slug-go {
          background: rgba(79, 124, 255, 0.15);
          border: 1px solid rgba(79, 124, 255, 0.3);
          border-radius: 12px;
          padding: 10px 18px;
          font-family: "Sora", sans-serif;
          font-size: 13px;
          font-weight: 500;
          color: #4f7cff;
          cursor: pointer;
          transition: all 0.2s;
        }
        .slug-go:hover {
          background: rgba(79, 124, 255, 0.25);
          border-color: rgba(79, 124, 255, 0.5);
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
          transition: all 0.3s ease;
        }
        .status-pill[data-state="live"] {
          border-color: rgba(46, 204, 113, 0.4);
          color: #2ecc71;
          box-shadow: 0 0 12px rgba(46, 204, 113, 0.15);
        }
        .status-pill[data-state="connecting"] {
          border-color: rgba(255, 170, 40, 0.4);
          color: #ffaa28;
        }
        .status-pill[data-state="reconnecting"] {
          border-color: rgba(231, 76, 60, 0.4);
          color: #e74c3c;
        }
        .status-pill[data-state="error"] {
          border-color: rgba(231, 76, 60, 0.6);
          color: #e74c3c;
          box-shadow: 0 0 12px rgba(231, 76, 60, 0.15);
        }
        .mmi-panel {
          background: linear-gradient(
            145deg,
            rgba(21, 27, 42, 0.95),
            rgba(12, 16, 28, 0.95)
          );
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
        .panel-metrics .metric {
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
          background: linear-gradient(
            160deg,
            rgba(12, 17, 30, 0.85),
            rgba(9, 12, 22, 0.95)
          );
          border-radius: 22px;
          padding: 20px 18px 16px;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .chart-stage {
          position: relative;
          border-radius: 18px;
          padding: 12px 12px 10px;
          background: linear-gradient(
            180deg,
            rgba(18, 22, 34, 0.9),
            rgba(10, 14, 24, 0.95)
          );
          overflow: hidden;
        }
        .lw-chart {
          width: 100%;
          height: 320px;
        }
        .signal-strip {
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 8px;
          height: 18px;
          z-index: 3;
        }
        .signal-band {
          position: absolute;
          top: 0;
          bottom: 0;
          border-radius: 10px;
          opacity: 0.7;
          cursor: pointer;
        }
        .signal-tooltip {
          position: absolute;
          right: 16px;
          top: 14px;
          z-index: 4;
          background: rgba(12, 16, 26, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          padding: 10px 12px;
          max-width: 320px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
        }
        .signal-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--ink);
        }
        .signal-window {
          margin-top: 4px;
          font-size: 11px;
          color: var(--muted);
        }
        .signal-text {
          margin-top: 6px;
          font-size: 12px;
          line-height: 1.4;
          color: #d6dbe8;
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
        }
      `}</style>
    </main>
  );
}

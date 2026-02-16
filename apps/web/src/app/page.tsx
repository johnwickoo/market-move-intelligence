"use client";

import { createChart, ColorType } from "lightweight-charts";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Annotation,
  MarketSnapshot,
  OutcomeSeries,
  SeriesPoint,
  PinnedSelection,
} from "../lib/types";
import { SignalBand, LANE_HEIGHT } from "../components/SignalBand";
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

function colorWithAlpha(color: string, alpha: number): string {
  const normalized = color.trim();
  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    if (full.length === 6) {
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
  }
  return normalized;
}

function buildLineData(series: SeriesPoint[]) {
  const points = series
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

  const nowSec = Math.floor(Date.now() / 1000);
  const lastPoint = deduped[deduped.length - 1];
  if (lastPoint && nowSec - lastPoint.time > 10) {
    deduped.push({ time: nowSec, value: lastPoint.value });
  }

  return deduped.slice(-MAX_POINTS);
}

/** Extend line data with padding at annotation boundaries so chart visible range includes signals. */
function buildLineDataWithAnnotationPadding(
  series: SeriesPoint[],
  annotations: Annotation[]
): Array<{ time: number; value: number }> {
  const base = buildLineData(series);
  if (base.length === 0 || annotations.length === 0) return base;

  let minAnnSec = Infinity;
  let maxAnnSec = -Infinity;
  for (const ann of annotations) {
    const startSec = Math.floor(Date.parse(ann.start_ts) / 1000);
    const endSec = Math.floor(Date.parse(ann.end_ts) / 1000);
    if (Number.isFinite(startSec)) minAnnSec = Math.min(minAnnSec, startSec);
    if (Number.isFinite(endSec)) maxAnnSec = Math.max(maxAnnSec, endSec);
  }
  if (!Number.isFinite(minAnnSec) || !Number.isFinite(maxAnnSec)) return base;

  const first = base[0];
  const last = base[base.length - 1];
  const result = [...base];
  if (first && minAnnSec < first.time) {
    result.unshift({ time: minAnnSec, value: first.value });
    result.sort((a, b) => a.time - b.time);
  }
  if (last && maxAnnSec > last.time) {
    result.push({ time: maxAnnSec, value: last.value });
    result.sort((a, b) => a.time - b.time);
  }
  return result.slice(-MAX_POINTS);
}

function outcomeKey(outcome: OutcomeSeries): string {
  return outcome.market_id ?? outcome.outcome;
}

// ── page component ──────────────────────────────────────────────────

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  params?: Promise<Record<string, string | undefined>>;
};

export default function Page(props: PageProps) {
  const searchParams = use(
    props.searchParams ??
      Promise.resolve({} as Record<string, string | string[] | undefined>)
  );
  const _params = use(
    props.params ??
      Promise.resolve({} as Record<string, string | undefined>)
  );

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

  // Resolve slug from URL (searchParams) → localStorage → env default (once on mount)
  useEffect(() => {
    const getStr = (v: string | string[] | undefined) =>
      Array.isArray(v) ? v[0] : v;
    const urlSlug = (
      getStr(searchParams.slug) ??
      getStr(searchParams.slugs) ??
      ""
    ).trim();
    const urlMarket = (
      getStr(searchParams.market_id) ??
      getStr(searchParams.marketId) ??
      ""
    ).trim();
    const urlAsset = (
      getStr(searchParams.asset_id) ?? getStr(searchParams.assetId) ?? ""
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
  }, [searchParams]);

  const [bucketMinutes, setBucketMinutes] = useState(inferredBucketMinutes);
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketsFor, setMarketsFor] = useState<string | null>(null);
  const [lastPrice, setLastPrice] = useState(0);
  const [rangePct, setRangePct] = useState(0);
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const lineSeriesRef = useRef<Map<string, any>>(new Map());
  const volumeSeriesRef = useRef<any>(null);
  const [signalWindows, setSignalWindows] = useState<Annotation[]>([]);
  const [hoveredSignal, setHoveredSignal] = useState<Annotation | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const [signalLayoutTick, setSignalLayoutTick] = useState(0);
  const [lineFilterKey, setLineFilterKey] = useState<string | null>(null);
  const [signalFlash, setSignalFlash] = useState(false);
  const prevSignalCountRef = useRef(0);

  const clearLineSeries = (
    chartOverride?: ReturnType<typeof createChart> | null
  ) => {
    const chart = chartOverride ?? chartRef.current;
    const seriesMap = lineSeriesRef.current;
    if (chart) {
      for (const series of seriesMap.values()) {
        chart.removeSeries(series);
      }
    }
    seriesMap.clear();
  };

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
      setMarketsFor(null);
      try {
        const base = pinned.marketId
          ? `/api/markets?market_id=${encodeURIComponent(pinned.marketId)}`
          : `/api/markets?slugs=${encodeURIComponent(slugs)}`;
        const res = await fetch(
          `${base}` +
            `&sinceHours=${inferredSinceHours}` +
            `&bucketMinutes=${inferredBucketMinutes}` +
            (pinned.assetId
              ? `&asset_id=${encodeURIComponent(pinned.assetId)}`
              : ""),
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = await res.json();
        if (!active) return;
        const rawMarkets = Array.isArray(json.markets) ? json.markets : [];
        const normalized = rawMarkets.map((m: MarketSnapshot) => ({
          ...m,
          outcomes: (m.outcomes ?? []).map((o: OutcomeSeries) => ({
            ...o,
            volumes: o.volumes ?? [],
          })),
        }));
        // Always replace markets — prevents stale data from a previous slug
        // lingering when the new slug has no data yet.
        setMarkets(normalized.length > 0 ? normalized : []);
        if (normalized.length > 0) {
          const key = pinned.marketId ? `market:${pinned.marketId}` : `slugs:${slugs}`;
          setMarketsFor(key);
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
  }, [slugs, inferredSinceHours, inferredBucketMinutes, pinned]);

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

    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: "#2ecc71",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
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
      clearLineSeries(chart);
      chart.remove();
      chartRef.current = null;
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
    () => markets.find((m) => m.slug === slug) ?? markets[0] ?? null,
    [slug, markets]
  );

  // Pick outcome:
  // 1) Prefer the outcome with the most recent annotation (signal/movement).
  // 2) Otherwise fall back to the most recent price point.
  // This keeps the focused outcome aligned with recent movement even when
  // the backend hasn't provided a dominant outcome.
  const selectedOutcomeLabel = useMemo(() => {
    const outcomes = selectedMarket?.outcomes ?? [];
    if (outcomes.length === 0) return "Yes";
    if (outcomes.length === 1) return outcomes[0]?.outcome ?? "Yes";

    let bestByAnnotation: { outcome: string; ts: number } | null = null;
    for (const outcome of outcomes) {
      const annotations = outcome.annotations ?? [];
      for (const ann of annotations) {
        const ts = Date.parse(ann.end_ts);
        if (!Number.isFinite(ts)) continue;
        if (!bestByAnnotation || ts > bestByAnnotation.ts) {
          bestByAnnotation = { outcome: outcome.outcome, ts };
        }
      }
    }
    if (bestByAnnotation) return bestByAnnotation.outcome;

    let bestBySeries: { outcome: string; ts: number } | null = null;
    for (const outcome of outcomes) {
      const last = outcome.series?.[outcome.series.length - 1];
      if (!last) continue;
      const ts = Date.parse(last.t);
      if (!Number.isFinite(ts)) continue;
      if (!bestBySeries || ts > bestBySeries.ts) {
        bestBySeries = { outcome: outcome.outcome, ts };
      }
    }
    if (bestBySeries) return bestBySeries.outcome;

    return outcomes[0]?.outcome ?? "Yes";
  }, [selectedMarket]);

  const isMultiMarketStream = useMemo(() => {
    if (pinned.marketId) return false;
    const key = `slugs:${slugs}`;
    if (marketsFor !== key) return false;
    if (markets.length === 0) return false;
    return markets.every(
      (market) => (market.child_market_ids?.length ?? 0) > 0
    );
  }, [markets, pinned.marketId, slugs, marketsFor]);

  const marketIdKey = useMemo(() => {
    if (pinned.marketId) return pinned.marketId;
    const key = `slugs:${slugs}`;
    if (marketsFor !== key) return "";
    const ids = new Set<string>();
    for (const market of markets) {
      if (isMultiMarketStream && market.child_market_ids?.length) {
        for (const childId of market.child_market_ids) ids.add(childId);
      } else if (market.market_id) {
        ids.add(market.market_id);
      }
    }
    return Array.from(ids).join(",");
  }, [markets, pinned.marketId, slugs, marketsFor, isMultiMarketStream]);

  // ── SSE stream (extracted hook) ───────────────────────────────────

  const streamStatus = useMarketStream({
    slugs,
    marketIdKey,
    bucketMinutes,
    windowStart,
    useRawTicks: false,
    pinnedAssetId: pinned.assetId,
    yesOnly: isMultiMarketStream,
    setMarkets,
  });

  const selectedOutcome = useMemo(
    () => {
      const outcomes = selectedMarket?.outcomes ?? [];
      if (lineFilterKey) {
        return (
          outcomes.find((o) => outcomeKey(o) === lineFilterKey) ??
          outcomes[0] ??
          null
        );
      }
      return (
        outcomes.find((o) => o.outcome === selectedOutcomeLabel) ??
        outcomes[0] ??
        null
      );
    },
    [selectedMarket, selectedOutcomeLabel, lineFilterKey]
  );

  const visibleOutcomes = useMemo(() => {
    const outcomes = selectedMarket?.outcomes ?? [];
    if (!lineFilterKey) return outcomes;
    return outcomes.filter((o) => outcomeKey(o) === lineFilterKey);
  }, [selectedMarket, lineFilterKey]);

  const visibleRange = useMemo(() => {
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const outcome of visibleOutcomes) {
      for (const point of outcome.series ?? []) {
        const ts = Date.parse(point.t);
        if (!Number.isFinite(ts)) continue;
        minMs = Math.min(minMs, ts);
        maxMs = Math.max(maxMs, ts);
      }
    }
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;
    return { minMs, maxMs };
  }, [visibleOutcomes]);

  const signalStats = useMemo(() => {
    let lastMs = 0;
    for (const ann of signalWindows) {
      const endMs = Date.parse(ann.end_ts);
      if (Number.isFinite(endMs)) {
        lastMs = Math.max(lastMs, endMs);
      }
    }
    return { count: signalWindows.length, lastMs };
  }, [signalWindows]);

  useEffect(() => {
    if (!lineFilterKey) return;
    const outcomes = selectedMarket?.outcomes ?? [];
    if (!outcomes.some((o) => outcomeKey(o) === lineFilterKey)) {
      setLineFilterKey(null);
    }
  }, [selectedMarket, lineFilterKey]);


  useEffect(() => {
    const volumeApi = volumeSeriesRef.current;
    clearLineSeries();
    if (volumeApi) volumeApi.setData([]);
    setSignalWindows([]);
    setHoveredSignal(null);
    setLineFilterKey(null);
  }, [slugs, pinned.marketId]);

  useEffect(() => {
    const merged: Annotation[] = [];
    const seenWindows = new Set<string>();
    for (const outcome of visibleOutcomes) {
      for (const ann of outcome.annotations ?? []) {
        const startMs = Date.parse(ann.start_ts);
        const endMs = Date.parse(ann.end_ts);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
        const windowKey = `${ann.start_ts}:${ann.end_ts}`;
        if (seenWindows.has(windowKey)) continue;
        seenWindows.add(windowKey);
        merged.push(ann);
      }
    }
    setSignalWindows(merged);
    setHoveredSignal(null);
  }, [visibleOutcomes]);

  // ── swim-lane assignment for overlapping signal bands ─────────────
  const { laneMap, laneCount } = useMemo(() => {
    const lanes: number[] = new Array(signalWindows.length).fill(0);
    // Sort indices by start time for greedy lane packing
    const indices = signalWindows
      .map((_, i) => i)
      .sort((a, b) => {
        const aMs = Date.parse(signalWindows[a].start_ts);
        const bMs = Date.parse(signalWindows[b].start_ts);
        return aMs - bMs;
      });
    // laneEnds[lane] = end timestamp (ms) of the last annotation in that lane
    const laneEnds: number[] = [];
    for (const i of indices) {
      const startMs = Date.parse(signalWindows[i].start_ts);
      const endMs = Date.parse(signalWindows[i].end_ts);
      // Find the lowest lane where this annotation doesn't overlap
      let placed = false;
      for (let l = 0; l < laneEnds.length; l++) {
        if (startMs >= laneEnds[l]) {
          lanes[i] = l;
          laneEnds[l] = endMs;
          placed = true;
          break;
        }
      }
      if (!placed) {
        lanes[i] = laneEnds.length;
        laneEnds.push(endMs);
      }
    }
    return { laneMap: lanes, laneCount: Math.max(1, laneEnds.length) };
  }, [signalWindows]);

  // ── flash when new signals arrive via SSE ─────────────────────────
  useEffect(() => {
    const prev = prevSignalCountRef.current;
    prevSignalCountRef.current = signalWindows.length;
    if (prev > 0 && signalWindows.length > prev) {
      setSignalFlash(true);
      const t = setTimeout(() => setSignalFlash(false), 2000);
      return () => clearTimeout(t);
    }
  }, [signalWindows.length]);

  // ── manual signal refresh (re-fetches from API without full page reload)
  const refreshSignals = useCallback(async () => {
    if (!slugs && !pinned.marketId) return;
    try {
      const base = pinned.marketId
        ? `/api/markets?market_id=${encodeURIComponent(pinned.marketId)}`
        : `/api/markets?slugs=${encodeURIComponent(slugs)}`;
      const res = await fetch(
        `${base}&sinceHours=${inferredSinceHours}&bucketMinutes=${inferredBucketMinutes}` +
          (pinned.assetId ? `&asset_id=${encodeURIComponent(pinned.assetId)}` : ""),
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const json = await res.json();
      const rawMarkets = Array.isArray(json.markets) ? json.markets : [];
      // Merge fresh annotations into existing markets (preserves live series data)
      setMarkets((prev) =>
        prev.map((m) => {
          const fresh = rawMarkets.find(
            (f: MarketSnapshot) => f.slug === m.slug
          );
          if (!fresh) return m;
          return {
            ...m,
            outcomes: m.outcomes.map((o) => {
              const freshOutcome = (fresh.outcomes ?? []).find(
                (fo: OutcomeSeries) => fo.outcome === o.outcome
              );
              if (!freshOutcome) return o;
              // Merge annotations: keep existing + add any new ones
              const existingKeys = new Set(
                o.annotations.map((a: Annotation) => `${a.start_ts}:${a.end_ts}`)
              );
              const newAnns = (freshOutcome.annotations ?? []).filter(
                (a: Annotation) => !existingKeys.has(`${a.start_ts}:${a.end_ts}`)
              );
              return newAnns.length > 0
                ? { ...o, annotations: [...o.annotations, ...newAnns] }
                : o;
            }),
          };
        })
      );
    } catch {
      // silent — non-critical refresh
    }
  }, [slugs, pinned.marketId, pinned.assetId, inferredSinceHours, inferredBucketMinutes]);

  // ── sync chart data ───────────────────────────────────────────────

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!selectedMarket) {
      clearLineSeries(chart);
      return;
    }

    const seriesMap = lineSeriesRef.current;
    const outcomes = selectedMarket.outcomes ?? [];
    const outcomesToRender = lineFilterKey
      ? outcomes.filter((o) => outcomeKey(o) === lineFilterKey)
      : outcomes;
    const activeKeys = new Set<string>();

    for (const outcome of outcomesToRender) {
      const key = outcomeKey(outcome);
      if (!key) continue;
      activeKeys.add(key);

      let series = seriesMap.get(key);
      if (!series) {
        series = chart.addLineSeries({
          color: outcome.color,
          lineWidth: 2,
          priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        });
        seriesMap.set(key, series);
      } else {
        series.applyOptions({ color: outcome.color });
      }

      series.setData(
        buildLineDataWithAnnotationPadding(
          outcome.series,
          outcome.annotations ?? []
        )
      );
    }

    for (const [key, series] of seriesMap.entries()) {
      if (activeKeys.has(key)) continue;
      chart.removeSeries(series);
      seriesMap.delete(key);
    }
  }, [selectedMarket, lineFilterKey]);

  useEffect(() => {
    const volumeApi = volumeSeriesRef.current;
    const volumeOutcomes = lineFilterKey
      ? selectedOutcome
        ? [selectedOutcome]
        : []
      : selectedMarket?.outcomes ?? [];

    if (!selectedOutcome && lineFilterKey) {
      if (volumeApi) volumeApi.setData([]);
      setLastPrice(0);
      setRangePct(0);
      return;
    }

    if (volumeApi) {
      const bucketMap = new Map<string, { buy: number; sell: number }>();
      for (const outcome of volumeOutcomes) {
        for (const v of outcome.volumes) {
          if (!v.t) continue;
          const entry = bucketMap.get(v.t) ?? { buy: 0, sell: 0 };
          entry.buy += Number(v.buy ?? 0);
          entry.sell += Number(v.sell ?? 0);
          bucketMap.set(v.t, entry);
        }
      }

      const volumePoints = Array.from(bucketMap.entries())
        .map(([t, vals]) => {
          const ts = Date.parse(t);
          if (!Number.isFinite(ts)) return null;
          const total = vals.buy + vals.sell;
          const delta = vals.buy - vals.sell;
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

    if (selectedOutcome) {
      const trimmed = buildLineData(selectedOutcome.series);
      if (trimmed.length > 0) {
        const values = trimmed.map((p) => p.value);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const last = trimmed[trimmed.length - 1]?.value ?? 0;
        const range = Math.max(0.0001, max - min);
        const pct = (range / Math.max(0.0001, max)) * 100;
        setLastPrice(last);
        setRangePct(pct);
      } else {
        setLastPrice(0);
        setRangePct(0);
      }
    } else {
      setLastPrice(0);
      setRangePct(0);
    }
  }, [selectedOutcome, selectedMarket, lineFilterKey]);

  const chartWindowLabel = `1m buckets · ${inferredSinceHours}h`;

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
          {slugs && (
            <div className="ingestion-pill">
              Ingestion locked · {slugs}
            </div>
          )}
        </div>
        <div className="status-pill" data-state={streamStatus}>
          {loading ? "Loading" : streamStatus}
          {error ? ` · ${error}` : ""}
        </div>
      </header>

      <section className="mmi-panel">
        <div className="panel-header">
          <div>
            <p className="market-title">{selectedMarket?.title ?? "Loading…"}</p>
            <p className="market-slug">{selectedMarket?.slug ?? slugs}</p>
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
            <div
              className={`signal-pill${signalFlash ? " signal-flash" : ""}`}
              data-active={signalStats.count > 0}
              title={
                signalStats.lastMs
                  ? new Date(signalStats.lastMs).toLocaleString()
                  : "No signals yet"
              }
            >
              Signals: {signalStats.count}
              {signalStats.lastMs
                ? ` · Last ${new Date(
                    signalStats.lastMs
                  ).toLocaleTimeString()}`
                : ""}
              <button
                type="button"
                className="signal-refresh-btn"
                onClick={refreshSignals}
                title="Refresh signals"
              >
                &#x21bb;
              </button>
            </div>
            {(selectedMarket?.outcomes?.length ?? 0) > 1 && selectedOutcome && (
              <div className="dominant-pill">
                Focused: {selectedOutcome.outcome}
              </div>
            )}
            {pinned.marketId && (
              <div className="dominant-pill">
                Pinned: {pinned.marketId.slice(0, 8)}…
              </div>
            )}
          </div>
        </div>

        {(selectedMarket?.outcomes?.length ?? 0) > 1 && (
          <div className="outcome-filters">
            <button
              type="button"
              className="outcome-filter"
              data-active={!lineFilterKey}
              onClick={() => setLineFilterKey(null)}
            >
              All outcomes
            </button>
            {selectedMarket?.outcomes.map((outcome) => {
              const key = outcomeKey(outcome);
              if (!key) return null;
              const active = lineFilterKey === key;
              const base = outcome.color;
              return (
                <button
                  key={key}
                  type="button"
                  className="outcome-filter"
                  data-active={active}
                  onClick={() => setLineFilterKey(active ? null : key)}
                  style={{
                    borderColor: colorWithAlpha(base, 0.55),
                    color: base,
                    background: colorWithAlpha(base, active ? 0.2 : 0.08),
                    boxShadow: active
                      ? `0 0 12px ${colorWithAlpha(base, 0.35)}`
                      : "none",
                  }}
                >
                  {outcome.outcome}
                </button>
              );
            })}
          </div>
        )}

        <div className="chart-card">
          <div className="chart-stage">
            <div ref={chartContainerRef} className="lw-chart" />
            <div
              className="signal-strip"
              style={{ height: `${laneCount * LANE_HEIGHT}px` }}
            >
              {signalWindows.map((signal, idx) => (
                <SignalBand
                  key={`${signal.kind}-${signal.start_ts}-${idx}`}
                  signal={signal}
                  chart={chartReady ? chartRef.current : null}
                  layoutVersion={signalLayoutTick}
                  lane={laneMap[idx] ?? 0}
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
        .ingestion-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-top: 10px;
          padding: 6px 12px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(12, 18, 30, 0.7);
          color: var(--muted);
          font-size: 12px;
          letter-spacing: 0.04em;
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
        .signal-pill {
          padding: 6px 12px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(12, 18, 30, 0.7);
          color: var(--muted);
          font-size: 12px;
          letter-spacing: 0.04em;
          white-space: nowrap;
        }
        .signal-pill[data-active="true"] {
          border-color: rgba(80, 220, 140, 0.4);
          color: #bfead6;
          box-shadow: 0 0 12px rgba(80, 220, 140, 0.15);
        }
        .signal-pill.signal-flash {
          animation: signalPulse 2s ease-out;
        }
        @keyframes signalPulse {
          0%   { box-shadow: 0 0 0 0 rgba(80, 220, 140, 0.6); }
          20%  { box-shadow: 0 0 18px 4px rgba(80, 220, 140, 0.45); }
          100% { box-shadow: 0 0 12px rgba(80, 220, 140, 0.15); }
        }
        .signal-refresh-btn {
          background: none;
          border: none;
          color: inherit;
          font-size: 14px;
          cursor: pointer;
          margin-left: 6px;
          padding: 0 2px;
          opacity: 0.5;
          transition: opacity 0.15s;
          vertical-align: middle;
        }
        .signal-refresh-btn:hover {
          opacity: 1;
        }
        .outcome-filters {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 18px;
        }
        .outcome-filter {
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(10, 14, 25, 0.7);
          color: var(--ink);
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 12px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .outcome-filter[data-active="true"] {
          border-color: rgba(255, 255, 255, 0.35);
          background: rgba(255, 255, 255, 0.08);
          transform: translateY(-1px);
        }
        .outcome-filter:hover {
          border-color: rgba(255, 255, 255, 0.3);
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
          z-index: 3;
        }
        .signal-band {
          position: absolute;
          border-radius: 10px;
          opacity: 0.7;
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .signal-band:hover {
          opacity: 1;
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

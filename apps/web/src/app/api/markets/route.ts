export const runtime = "nodejs";

import {
  type RawTick,
  type RawTrade,
  type RawMovement,
  pgFetch,
  toNum,
  slugFromRaw,
  titleFromRaw,
  colorForOutcome,
  fetchDominantOutcomes,
  fetchExplanations,
} from "../../../lib/supabase";

const DEFAULT_BUCKET_MINUTES = 1;
const DEFAULT_SINCE_HOURS = 24;

function clampBucketMinutes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BUCKET_MINUTES;
  return Math.max(1, Math.floor(value));
}

function buildBucketSeries(
  ticks: RawTick[],
  trades: RawTrade[],
  windowStartMs: number,
  windowEndMs: number,
  bucketMinutes: number
) {
  const bucketMs = clampBucketMinutes(bucketMinutes) * 60 * 1000;
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    return [] as Array<{ t: string; price: number; volume: number }>;
  }

  const bucketCount =
    Math.max(1, Math.floor((windowEndMs - windowStartMs) / bucketMs) + 1);
  const series: Array<{ t: string; price: number; volume: number }> =
    Array.from({ length: bucketCount }, (_, i) => ({
      t: new Date(windowStartMs + i * bucketMs).toISOString(),
      price: Number.NaN,
      volume: 0,
    }));

  for (const tk of ticks) {
    if (tk.mid == null) continue;
    const tsMs = Date.parse(tk.ts);
    if (!Number.isFinite(tsMs) || tsMs < windowStartMs) continue;
    const idx = Math.floor((tsMs - windowStartMs) / bucketMs);
    if (idx < 0 || idx >= series.length) continue;
    series[idx].price = toNum(tk.mid);
  }

  let lastPrice: number | null = null;
  for (const point of series) {
    if (Number.isFinite(point.price)) {
      lastPrice = point.price;
    } else if (lastPrice != null) {
      point.price = lastPrice;
    }
  }

  const firstIndex = series.findIndex((p) => Number.isFinite(p.price));
  if (firstIndex === -1) return [];

  const firstPrice = series[firstIndex].price;
  for (let i = 0; i < firstIndex; i += 1) {
    series[i].price = firstPrice;
  }

  for (const tr of trades) {
    const tsMs = Date.parse(tr.timestamp);
    if (!Number.isFinite(tsMs) || tsMs < windowStartMs) continue;
    const idx = Math.floor((tsMs - windowStartMs) / bucketMs);
    if (idx < 0 || idx >= series.length) continue;
    series[idx].volume += toNum(tr.size ?? 0);
  }

  return series;
}

function buildVolumeBuckets(
  trades: RawTrade[],
  windowStartMs: number,
  windowEndMs: number,
  bucketMinutes: number
) {
  const bucketMs = clampBucketMinutes(bucketMinutes) * 60 * 1000;
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    return [] as Array<{ t: string; buy: number; sell: number }>;
  }

  const bucketCount =
    Math.max(1, Math.floor((windowEndMs - windowStartMs) / bucketMs) + 1);
  const buckets: Array<{ t: string; buy: number; sell: number }> =
    Array.from({ length: bucketCount }, (_, i) => ({
      t: new Date(windowStartMs + i * bucketMs).toISOString(),
      buy: 0,
      sell: 0,
    }));

  for (const tr of trades) {
    const tsMs = Date.parse(tr.timestamp);
    if (!Number.isFinite(tsMs) || tsMs < windowStartMs) continue;
    const idx = Math.floor((tsMs - windowStartMs) / bucketMs);
    if (idx < 0 || idx >= buckets.length) continue;
    const side = String(tr.side ?? "").toUpperCase();
    const size = toNum(tr.size ?? 0);
    if (side === "BUY") {
      buckets[idx].buy += size;
    } else if (side === "SELL") {
      buckets[idx].sell += size;
    }
  }

  return buckets;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slugsParam = searchParams.get("slugs") ?? "";
  const slugList = slugsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const marketIdParam = searchParams.get("market_id");
  const assetIdParam = (searchParams.get("asset_id") ?? "").trim();
  const sinceHours = Number(
    searchParams.get("sinceHours") ?? DEFAULT_SINCE_HOURS
  );
  const raw = searchParams.get("raw") === "1";
  const bucketMinutes = clampBucketMinutes(
    Number(searchParams.get("bucketMinutes") ?? DEFAULT_BUCKET_MINUTES)
  );

  const bucketMs = bucketMinutes * 60 * 1000;
  const nowMs = Date.now();
  const windowEndMs = Math.floor(nowMs / bucketMs) * bucketMs;
  const windowStartMs =
    windowEndMs - Math.max(1, sinceHours) * 60 * 60 * 1000;
  const windowStartISO = new Date(windowStartMs).toISOString();

  const markets = new Map<
    string,
    { slug: string; title: string; outcomes: Set<string> }
  >();

  if (marketIdParam) {
    markets.set(marketIdParam, {
      slug: marketIdParam,
      title: marketIdParam,
      outcomes: new Set<string>(),
    });
  } else if (slugList.length > 0) {
    const trades = await pgFetch<RawTrade[]>(
      `trades?select=market_id,outcome,timestamp,raw` +
        `&timestamp=gte.${encodeURIComponent(windowStartISO)}` +
        `&order=timestamp.desc&limit=2000`
    );

    for (const t of trades) {
      const slug = slugFromRaw(t.raw);
      if (!slug || !slugList.includes(slug)) continue;
      const entry = markets.get(t.market_id) ?? {
        slug,
        title: titleFromRaw(t.raw) ?? slug,
        outcomes: new Set<string>(),
      };
      if (t.outcome) entry.outcomes.add(String(t.outcome));
      markets.set(t.market_id, entry);
    }
  }

  // When multiple markets share the same slug, keep only the most recent
  if (!marketIdParam && slugList.length > 0 && markets.size > 1) {
    const marketIds = Array.from(markets.keys());
    const lastTickByMarket = new Map<string, number>();
    if (marketIds.length > 0) {
      const ticks = await pgFetch<Pick<RawTick, "market_id" | "ts">[]>(
        `market_mid_ticks?select=market_id,ts` +
          `&market_id=in.(${marketIds.join(",")})` +
          `&order=ts.desc&limit=2000`
      );
      for (const tk of ticks) {
        if (lastTickByMarket.has(tk.market_id)) continue;
        const ms = Date.parse(tk.ts);
        if (!Number.isFinite(ms)) continue;
        lastTickByMarket.set(tk.market_id, ms);
      }
    }

    const bestBySlug = new Map<string, { marketId: string; ts: number }>();
    for (const [marketId, meta] of markets.entries()) {
      const ts = lastTickByMarket.get(marketId) ?? 0;
      const prev = bestBySlug.get(meta.slug);
      if (!prev || ts > prev.ts) {
        bestBySlug.set(meta.slug, { marketId, ts });
      }
    }

    const selected = new Set(
      Array.from(bestBySlug.values()).map((entry) => entry.marketId)
    );
    for (const id of Array.from(markets.keys())) {
      if (!selected.has(id)) markets.delete(id);
    }
  }

  // Discover outcomes from ticks
  if (markets.size > 0) {
    const marketIds = Array.from(markets.keys());
    const tickOutcomes = await pgFetch<
      Pick<RawTick, "market_id" | "outcome" | "asset_id">[]
    >(
      `market_mid_ticks?select=market_id,outcome,asset_id` +
        `&market_id=in.(${marketIds.join(",")})` +
        (assetIdParam
          ? `&asset_id=eq.${encodeURIComponent(assetIdParam)}`
          : "") +
        `&ts=gte.${encodeURIComponent(windowStartISO)}` +
        `&order=ts.desc&limit=2000`
    );

    for (const tk of tickOutcomes) {
      if (!tk.outcome) continue;
      if (assetIdParam && tk.asset_id && tk.asset_id !== assetIdParam) continue;
      const entry = markets.get(tk.market_id);
      if (!entry) continue;
      entry.outcomes.add(String(tk.outcome));
    }
  }

  const marketIds = Array.from(markets.keys());
  const dominantByMarket = await fetchDominantOutcomes(marketIds);

  const payloadMarkets = [];

  for (const [marketId, meta] of markets.entries()) {
    const dominant = dominantByMarket.get(marketId);
    const outcomes = dominant
      ? [dominant]
      : meta.outcomes.size > 0
        ? Array.from(meta.outcomes)
        : ["Yes", "No"];

    const outcomeSeries = [];

    for (const outcome of outcomes) {
      const color = colorForOutcome(outcome);

      const ticks = await pgFetch<RawTick[]>(
        `market_mid_ticks?select=market_id,outcome,asset_id,ts,mid` +
          `&market_id=eq.${marketId}` +
          `&outcome=eq.${encodeURIComponent(outcome)}` +
          (assetIdParam
            ? `&asset_id=eq.${encodeURIComponent(assetIdParam)}`
            : "") +
          `&ts=gte.${encodeURIComponent(windowStartISO)}` +
          `&order=ts.asc&limit=5000`
      );

      const trades = await pgFetch<RawTrade[]>(
        `trades?select=market_id,outcome,timestamp,size,side` +
          `&market_id=eq.${marketId}` +
          `&outcome=eq.${encodeURIComponent(outcome)}` +
          `&timestamp=gte.${encodeURIComponent(windowStartISO)}` +
          `&order=timestamp.asc&limit=5000`
      );

      const series = raw
        ? ticks
            .filter((tk) => tk.mid != null)
            .map((tk) => ({
              t: tk.ts,
              price: toNum(tk.mid),
              volume: 0,
            }))
        : buildBucketSeries(
            ticks,
            trades,
            windowStartMs,
            windowEndMs,
            bucketMinutes
          );

      const volumes = buildVolumeBuckets(
        trades,
        windowStartMs,
        windowEndMs,
        bucketMinutes
      );

      const movements = await pgFetch<RawMovement[]>(
        `market_movements?select=id,market_id,outcome,window_start,window_end,window_type,reason` +
          `&market_id=eq.${marketId}` +
          `&outcome=eq.${encodeURIComponent(outcome)}` +
          `&window_end=gte.${encodeURIComponent(windowStartISO)}` +
          `&order=window_end.desc&limit=50`
      );

      const explanations = await fetchExplanations(
        movements.map((m) => m.id)
      );

      const annotations = movements.map((m) => {
        const label = m.window_type === "event" ? "Movement" : "Signal";
        return {
          kind: m.window_type === "event" ? "movement" : "signal",
          start_ts: m.window_start,
          end_ts: m.window_end,
          label,
          explanation:
            explanations[m.id] ??
            `${label}: ${m.reason.toLowerCase()} move detected.`,
          color:
            m.window_type === "event"
              ? "rgba(80, 220, 140, 0.22)"
              : "rgba(255, 170, 40, 0.2)",
        };
      });

      outcomeSeries.push({ outcome, color, series, volumes, annotations });
    }

    payloadMarkets.push({
      market_id: marketId,
      slug: meta.slug,
      title: meta.title,
      outcomes: outcomeSeries,
    });
  }

  return Response.json({
    windowStart: windowStartISO,
    bucketMinutes: raw ? 0 : bucketMinutes,
    markets: payloadMarkets,
  });
}

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
  colorForIndex,
  fetchDominantOutcomes,
  fetchExplanations,
  resolveActiveMarketIds,
} from "../../../lib/supabase";

const DEFAULT_BUCKET_MINUTES = 1;
const DEFAULT_SINCE_HOURS = 24;

// ── Movement display helpers for multi-window types ──────────────────
function movementLabel(windowType: string, isEvent = false): string {
  if (windowType === "event") return isEvent ? "Event Movement" : "Movement";
  if (windowType === "5m") return isEvent ? "Event Impulse (5m)" : "Impulse (5m)";
  if (windowType === "15m") return isEvent ? "Event Move (15m)" : "Move (15m)";
  if (windowType === "1h") return isEvent ? "Event Move (1h)" : "Move (1h)";
  if (windowType === "4h") return isEvent ? "Event Shift (4h)" : "Shift (4h)";
  return isEvent ? "Event Signal" : "Signal";
}

function movementKind(windowType: string): string {
  // Short windows are movements (actionable), longer are signals (contextual)
  if (windowType === "event" || windowType === "5m" || windowType === "15m") return "movement";
  return "signal";
}

function movementColor(windowType: string, isEvent = false): string {
  if (isEvent) {
    if (windowType === "event" || windowType === "5m" || windowType === "15m") return "rgba(96, 169, 255, 0.22)";
    return "rgba(96, 169, 255, 0.14)";
  }
  if (windowType === "event" || windowType === "5m" || windowType === "15m") return "rgba(80, 220, 140, 0.22)";
  if (windowType === "1h") return "rgba(255, 170, 40, 0.2)";
  return "rgba(255, 170, 40, 0.14)";
}

function clampBucketMinutes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BUCKET_MINUTES;
  return Math.max(1, Math.floor(value));
}

/** Inserts " for market [name]" into the first price sentence (e.g. "Price moved 5% over 24h." → "Price moved 5% for market X over 24h."). */
function withMarketInExplanation(explanation: string, marketName: string): string {
  if (!marketName || !explanation) return explanation;
  return explanation.replace(
    /^(Price moved \d+%)( over )/,
    `$1 for market ${marketName}$2`
  );
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

  // Find the last bucket with a real tick (not forward-filled)
  let lastRealIndex = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    if (Number.isFinite(series[i].price)) {
      lastRealIndex = i;
      break;
    }
  }
  if (lastRealIndex === -1) return [];

  // Forward-fill gaps between real ticks, but only up to the last real tick.
  // This prevents the stream's upsertBucketPoint from finding pre-allocated
  // forward-filled buckets via findIndex, which would cause the chart's
  // "last price" to appear stagnant.
  let lastPrice: number | null = null;
  for (let i = 0; i <= lastRealIndex; i++) {
    if (Number.isFinite(series[i].price)) {
      lastPrice = series[i].price;
    } else if (lastPrice != null) {
      series[i].price = lastPrice;
    }
  }

  const firstIndex = series.findIndex((p) => Number.isFinite(p.price));
  if (firstIndex === -1) return [];

  const firstPrice = series[firstIndex].price;
  for (let i = 0; i < firstIndex; i += 1) {
    series[i].price = firstPrice;
  }

  // Trim: only include buckets up to the last real tick. Do not keep trailing
  // forward-filled buckets — the stream will push new buckets as ticks arrive,
  // and we must not let findIndex hit pre-allocated forward-filled slots.
  const nowBucketIndex = Math.floor(
    (Date.now() - windowStartMs) / bucketMs
  );
  const trimToIndex = Math.min(
    lastRealIndex,
    Math.max(0, nowBucketIndex)
  );
  const trimmed = series.slice(0, trimToIndex + 1);

  for (const tr of trades) {
    const tsMs = Date.parse(tr.timestamp);
    if (!Number.isFinite(tsMs) || tsMs < windowStartMs) continue;
    const idx = Math.floor((tsMs - windowStartMs) / bucketMs);
    if (idx < 0 || idx >= trimmed.length) continue;
    trimmed[idx].volume += toNum(tr.size ?? 0);
  }

  return trimmed;
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

async function fetchEventAnnotations(
  eventSlug: string,
  windowStartISO: string,
  eventName?: string
) {
  const eventMarketId = `event:${eventSlug}`;
  const moves = await pgFetch<RawMovement[]>(
    `market_movements?select=id,market_id,outcome,window_start,window_end,window_type,reason,start_price` +
      `&market_id=eq.${encodeURIComponent(eventMarketId)}` +
      `&window_end=gte.${encodeURIComponent(windowStartISO)}` +
      `&order=window_end.desc&limit=50`
  );

  if (!Array.isArray(moves) || moves.length === 0) return [];
  const explanations = await fetchExplanations(moves.map((m) => m.id));
  const name =
    eventName ?? eventSlug.replace(/-/g, " ");

  return moves.map((m) => {
    const label = movementLabel(m.window_type, true);
    const raw =
      explanations[m.id] ??
      `${label}: ${m.reason.toLowerCase()} move detected.`;
    const explanation = withMarketInExplanation(raw, name);
    return {
      kind: movementKind(m.window_type),
      start_ts: m.window_start,
      end_ts: m.window_end,
      label,
      explanation,
      color: movementColor(m.window_type, true),
      start_price: m.start_price ?? null,
    };
  });
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

    // Fallback: if slug matching found nothing (e.g. user entered "POLY-194107"
    // but raw data has eventSlug "who-will-trump..."), resolve from recent activity
    if (markets.size === 0) {
      const active = await resolveActiveMarketIds(10);
      for (const [id, meta] of active) {
        markets.set(id, meta);
      }
    }
  }

  // ── Group market_ids by slug to detect multi-market events ──────────
  const marketIdsBySlug = new Map<string, string[]>();
  for (const [marketId, meta] of markets.entries()) {
    const arr = marketIdsBySlug.get(meta.slug) ?? [];
    arr.push(marketId);
    marketIdsBySlug.set(meta.slug, arr);
  }

  // Detect multi-market events: multiple market_ids with different titles
  const multiMarketSlugs = new Set<string>();
  for (const [slug, ids] of marketIdsBySlug.entries()) {
    if (ids.length <= 1) continue;
    const titles = new Set(ids.map((id) => markets.get(id)!.title));
    if (titles.size > 1) {
      multiMarketSlugs.add(slug);
    } else {
      // Same title = slug recycling, keep only the most recent
      const lastTickByMarket = new Map<string, number>();
      const ticks = await pgFetch<Pick<RawTick, "market_id" | "ts">[]>(
        `market_mid_ticks?select=market_id,ts` +
          `&market_id=in.(${ids.join(",")})` +
          `&order=ts.desc&limit=2000`
      );
      for (const tk of ticks) {
        if (lastTickByMarket.has(tk.market_id)) continue;
        const ms = Date.parse(tk.ts);
        if (Number.isFinite(ms)) lastTickByMarket.set(tk.market_id, ms);
      }
      let bestId = ids[0];
      let bestTs = 0;
      for (const id of ids) {
        const ts = lastTickByMarket.get(id) ?? 0;
        if (ts > bestTs) {
          bestTs = ts;
          bestId = id;
        }
      }
      for (const id of ids) {
        if (id !== bestId) markets.delete(id);
      }
    }
  }

  // Discover outcomes from ticks (for single-market entries)
  const allMarketIds = Array.from(markets.keys());
  if (allMarketIds.length > 0) {
    const tickOutcomes = await pgFetch<
      Pick<RawTick, "market_id" | "outcome" | "asset_id">[]
    >(
      `market_mid_ticks?select=market_id,outcome,asset_id` +
        `&market_id=in.(${allMarketIds.join(",")})` +
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

  const dominantByMarket = await fetchDominantOutcomes(allMarketIds);

  // ── Helper: fetch outcome data for a single market_id + outcome ────
  async function fetchOutcomeData(
    marketId: string,
    outcome: string,
    marketTitle?: string
  ) {
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
      : buildBucketSeries(ticks, trades, windowStartMs, windowEndMs, bucketMinutes);

    const volumes = buildVolumeBuckets(trades, windowStartMs, windowEndMs, bucketMinutes);

    const movements = await pgFetch<RawMovement[]>(
      `market_movements?select=id,market_id,outcome,window_start,window_end,window_type,reason,start_price` +
        `&market_id=eq.${marketId}` +
        `&outcome=eq.${encodeURIComponent(outcome)}` +
        `&window_end=gte.${encodeURIComponent(windowStartISO)}` +
        `&order=window_end.desc&limit=50`
    );

    const explanations = await fetchExplanations(movements.map((m) => m.id));

    const annotations = movements.map((m) => {
      const label = movementLabel(m.window_type);
      const raw =
        explanations[m.id] ??
        `${label}: ${m.reason.toLowerCase()} move detected.`;
      const explanation = marketTitle
        ? withMarketInExplanation(raw, marketTitle)
        : raw;
      return {
        kind: movementKind(m.window_type),
        start_ts: m.window_start,
        end_ts: m.window_end,
        label,
        explanation,
        color: movementColor(m.window_type),
        start_price: m.start_price ?? null,
      };
    });

    return { series, volumes, annotations, tickCount: ticks.length };
  }

  // ── Build payload ──────────────────────────────────────────────────
  const payloadMarkets = [];

  // Track which slugs we've already emitted (to avoid duplicating multi-market)
  const emittedSlugs = new Set<string>();

  for (const [marketId, meta] of markets.entries()) {
    if (emittedSlugs.has(meta.slug)) continue;

    // ── Multi-market event: merge all children, Yes-only ───────────
    if (multiMarketSlugs.has(meta.slug)) {
      emittedSlugs.add(meta.slug);
      const childIds = marketIdsBySlug.get(meta.slug) ?? [marketId];
      const outcomeSeries = [];

      // Sort children by title for stable ordering
      const sortedChildren = childIds
        .map((id) => ({ id, title: markets.get(id)!.title }))
        .sort((a, b) => a.title.localeCompare(b.title));

      console.log("[/api/markets] multi-market", {
        slug: meta.slug,
        childCount: sortedChildren.length,
        children: sortedChildren.map((c) => c.title),
      });

      const eventName = meta.slug.replace(/-/g, " ");
      const eventAnnotations = await fetchEventAnnotations(
        meta.slug,
        windowStartISO,
        eventName
      );

      for (let i = 0; i < sortedChildren.length; i++) {
        const child = sortedChildren[i];
        const data = await fetchOutcomeData(child.id, "Yes", child.title);

        // Skip children with no data
        if (data.series.length === 0 && data.tickCount === 0) continue;

        console.log("[/api/markets] child ticks", {
          marketId: child.id.slice(0, 12),
          title: child.title,
          tickCount: data.tickCount,
        });

        outcomeSeries.push({
          outcome: child.title,
          market_id: child.id,
          color: colorForIndex(i),
          series: data.series,
          volumes: data.volumes,
          annotations:
            eventAnnotations.length > 0
              ? [...data.annotations, ...eventAnnotations]
              : data.annotations,
        });
      }

      // Use the event slug as title — first child's slug is the event slug
      payloadMarkets.push({
        market_id: childIds[0],
        slug: meta.slug,
        title: meta.slug.replace(/-/g, " "),
        outcomes: outcomeSeries,
        child_market_ids: childIds,
      });
      continue;
    }

    // ── Single market: existing logic ─────────────────────────────
    emittedSlugs.add(meta.slug);
    const dominant = dominantByMarket.get(marketId);

    // For binary markets (Yes/No, Up/Down), always show the primary outcome
    // (index-0). The complement is redundant (1 - primary). This prevents
    // chart flipping when the dominant outcome oscillates based on trade volume.
    const BINARY_PAIRS = [["Yes", "No"], ["Up", "Down"]];
    const arr = [...meta.outcomes];
    const binaryPair = meta.outcomes.size <= 2
      ? BINARY_PAIRS.find(([a, b]) => arr.includes(a) && arr.includes(b))
      : undefined;
    const isBinary = meta.outcomes.size === 0 || !!binaryPair;

    const outcomes = isBinary
      ? [dominant ?? binaryPair?.[0] ?? "Yes"]
      : dominant
        ? [dominant]
        : Array.from(meta.outcomes);

    console.log("[/api/markets]", {
      marketId,
      slug: meta.slug,
      dominant,
      discoveredOutcomes: Array.from(meta.outcomes),
      queryOutcomes: outcomes,
    });

    const outcomeSeries = [];

    for (const outcome of outcomes) {
      const data = await fetchOutcomeData(marketId, outcome, meta.title);

      console.log("[/api/markets] ticks", {
        marketId: marketId.slice(0, 12),
        outcome,
        tickCount: data.tickCount,
      });

      outcomeSeries.push({
        outcome,
        color: colorForOutcome(outcome),
        series: data.series,
        volumes: data.volumes,
        annotations: data.annotations,
      });
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

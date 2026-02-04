export const runtime = "nodejs";

type RawTrade = {
  market_id: string;
  outcome: string | null;
  timestamp: string;
  size?: number;
  raw?: any;
};

type RawTick = {
  market_id: string;
  outcome: string | null;
  ts: string;
  mid: number | null;
};

type RawMovement = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_start: string;
  window_end: string;
  window_type: "24h" | "event";
  reason: string;
};

const DEFAULT_BUCKET_MINUTES = 1;
const DEFAULT_SINCE_HOURS = 24;

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

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
  const tickShiftMs = bucketMs;
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
    const rawMs = Date.parse(tk.ts);
    const tsMs = Number.isFinite(rawMs) ? rawMs - tickShiftMs : rawMs;
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
  if (firstIndex === -1) {
    return [];
  }

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

function getEnv(key: string) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

async function pgFetch(path: string) {
  const url = `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json();
}

function slugFromRaw(raw: any): string | null {
  const payload = raw?.payload ?? raw;
  return (
    payload?.eventSlug ??
    payload?.slug ??
    payload?.marketSlug ??
    payload?.market_slug ??
    null
  );
}

function titleFromRaw(raw: any): string | null {
  const payload = raw?.payload ?? raw;
  return payload?.title ?? payload?.market_title ?? null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slugsParam = searchParams.get("slugs") ?? "";
  const slugList = slugsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const marketIdParam = searchParams.get("market_id");
  const sinceHours = Number(searchParams.get("sinceHours") ?? DEFAULT_SINCE_HOURS);
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
    const trades = (await pgFetch(
      `trades?select=market_id,outcome,timestamp,raw` +
        `&timestamp=gte.${encodeURIComponent(windowStartISO)}` +
        `&order=timestamp.desc&limit=2000`
    )) as RawTrade[];

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

  if (!marketIdParam && slugList.length > 0 && markets.size > 1) {
    const marketIds = Array.from(markets.keys());
    const lastTickByMarket = new Map<string, number>();
    if (marketIds.length > 0) {
      const ticks = (await pgFetch(
        `market_mid_ticks?select=market_id,ts` +
          `&market_id=in.(${marketIds.join(",")})` +
          `&order=ts.desc&limit=2000`
      )) as Pick<RawTick, "market_id" | "ts">[];

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

  if (markets.size > 0) {
    const marketIds = Array.from(markets.keys());
    const tickOutcomes = (await pgFetch(
      `market_mid_ticks?select=market_id,outcome` +
        `&market_id=in.(${marketIds.join(",")})` +
        `&ts=gte.${encodeURIComponent(windowStartISO)}` +
        `&order=ts.desc&limit=2000`
    )) as Pick<RawTick, "market_id" | "outcome">[];

    for (const tk of tickOutcomes) {
      if (!tk.outcome) continue;
      const entry = markets.get(tk.market_id);
      if (!entry) continue;
      entry.outcomes.add(String(tk.outcome));
    }
  }

  const payloadMarkets = [];

  for (const [marketId, meta] of markets.entries()) {
    const outcomes =
      meta.outcomes.size > 0 ? Array.from(meta.outcomes) : ["Yes", "No"];

    const outcomeSeries = [];

    for (const outcome of outcomes) {
      const normalizedOutcome = outcome.toLowerCase();
      const color =
        normalizedOutcome === "yes" || normalizedOutcome === "up"
          ? "#ff6a3d"
          : normalizedOutcome === "no" || normalizedOutcome === "down"
            ? "#3a6bff"
            : "#9aa3b8";
      const ticks = (await pgFetch(
        `market_mid_ticks?select=market_id,outcome,ts,mid` +
          `&market_id=eq.${marketId}` +
          `&outcome=eq.${encodeURIComponent(outcome)}` +
          `&ts=gte.${encodeURIComponent(windowStartISO)}` +
          `&order=ts.asc&limit=5000`
      )) as RawTick[];

      const trades = raw
        ? []
        : ((await pgFetch(
            `trades?select=market_id,outcome,timestamp,size` +
              `&market_id=eq.${marketId}` +
              `&outcome=eq.${encodeURIComponent(outcome)}` +
              `&timestamp=gte.${encodeURIComponent(windowStartISO)}` +
              `&order=timestamp.asc&limit=5000`
          )) as RawTrade[]);

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

      const movements = (await pgFetch(
        `market_movements?select=id,market_id,outcome,window_start,window_end,window_type,reason` +
          `&market_id=eq.${marketId}` +
          `&outcome=eq.${encodeURIComponent(outcome)}` +
          `&window_end=gte.${encodeURIComponent(windowStartISO)}` +
          `&order=window_end.desc&limit=50`
      )) as RawMovement[];

      const movementIds = movements.map((m) => m.id);
      let explanations: Record<string, string> = {};
      if (movementIds.length > 0) {
        try {
          const expRows = (await pgFetch(
            `movement_explanations?select=movement_id,text` +
              `&movement_id=in.(${movementIds.map(encodeURIComponent).join(",")})`
          )) as { movement_id: string; text: string }[];
          explanations = Object.fromEntries(
            expRows.map((r) => [r.movement_id, r.text])
          );
        } catch {
          explanations = {};
        }
      }

      const seriesMs = series.map((p) => Date.parse(p.t));
      const indexForTs = (tsMs: number) => {
        if (!Number.isFinite(tsMs) || seriesMs.length === 0) return 0;
        const firstMs = seriesMs[0];
        const lastMs = seriesMs[seriesMs.length - 1];
        if (Number.isFinite(firstMs) && tsMs <= firstMs) return 0;
        if (Number.isFinite(lastMs) && tsMs >= lastMs) return seriesMs.length - 1;
        for (let i = 0; i < seriesMs.length; i += 1) {
          const pointMs = seriesMs[i];
          if (!Number.isFinite(pointMs)) continue;
          if (pointMs >= tsMs) return i;
        }
        return seriesMs.length - 1;
      };

      const annotations = movements.map((m) => {
        const startMs = Date.parse(m.window_start);
        const endMs = Date.parse(m.window_end);
        const startIndex = indexForTs(startMs);
        const endIndex = indexForTs(endMs);
        const label = m.window_type === "event" ? "Movement" : "Signal";
        return {
          kind: m.window_type === "event" ? "movement" : "signal",
          startIndex,
          endIndex,
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

      outcomeSeries.push({
        outcome,
        color,
        series,
        annotations,
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

export const runtime = "nodejs";

type RawTrade = {
  market_id: string;
  outcome: string | null;
  timestamp: string;
  size?: number;
  side?: string;
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

type DominantOutcomeRow = {
  market_id: string;
  outcome: string | null;
};

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

function toNum(x: any): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slugsParam = searchParams.get("slugs") ?? "";
  const marketIdsParam = searchParams.get("market_id") ?? "";
  const slugList = slugsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bucketMinutes = Math.max(
    1,
    Number(searchParams.get("bucketMinutes") ?? 1)
  );

  const markets = new Map<
    string,
    { slug: string; outcomes: Set<string> }
  >();

  if (marketIdsParam) {
    for (const id of marketIdsParam.split(",").map((s) => s.trim())) {
      if (!id) continue;
      markets.set(id, { slug: id, outcomes: new Set<string>() });
    }
  } else if (slugList.length > 0) {
    const trades = (await pgFetch(
      `trades?select=market_id,outcome,timestamp,raw` +
        `&order=timestamp.desc&limit=2000`
    )) as RawTrade[];
    for (const t of trades) {
      const slug = slugFromRaw(t.raw);
      if (!slug || !slugList.includes(slug)) continue;
      const entry =
        markets.get(t.market_id) ??
        ({ slug, outcomes: new Set<string>() } as {
          slug: string;
          outcomes: Set<string>;
        });
      if (t.outcome) entry.outcomes.add(String(t.outcome));
      markets.set(t.market_id, entry);
    }
  }

  if (!marketIdsParam && slugList.length > 0 && markets.size > 1) {
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

  const marketIds = Array.from(markets.keys());
  if (marketIds.length === 0) {
    return new Response("no markets", { status: 400 });
  }

  const dominantByMarket = new Map<string, string>();
  if (marketIds.length > 0) {
    try {
      const dominantRows = (await pgFetch(
        `market_dominant_outcomes?select=market_id,outcome` +
          `&market_id=in.(${marketIds.join(",")})`
      )) as DominantOutcomeRow[];
      for (const row of dominantRows) {
        if (row.outcome) dominantByMarket.set(row.market_id, String(row.outcome));
      }
    } catch {
      // ignore dominant lookup failures
    }
  }

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let stop: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      let lastTickIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      let lastTradeIso = lastTickIso;
      let lastMoveIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      stop = () => {
        if (poll) clearInterval(poll);
        if (heartbeat) clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // ignore
          }
        }
      };

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
          if (stop) stop();
        }
      };

      const send = (event: string, data: any) => {
        if (closed) return;
        safeEnqueue(encoder.encode(`event: ${event}\n`));
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`: keep-alive\n\n`));
      }, 15000);

      void (async () => {
        try {
          const latestTicks = (await pgFetch(
            `market_mid_ticks?select=market_id,outcome,ts,mid` +
              `&market_id=in.(${marketIds.join(",")})` +
              `&order=ts.desc&limit=2000`
          )) as RawTick[];

          const seen = new Set<string>();
          for (const tk of latestTicks) {
            if (tk.mid == null) continue;
            const dominant = dominantByMarket.get(tk.market_id);
            if (dominant && tk.outcome !== dominant) continue;
            const key = `${tk.market_id}:${tk.outcome ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            lastTickIso = tk.ts > lastTickIso ? tk.ts : lastTickIso;
            send("tick", {
              market_id: tk.market_id,
              outcome: tk.outcome,
              ts: tk.ts,
              mid: tk.mid,
              bucketMinutes,
            });
          }
        } catch (err: any) {
          send("error", { message: err?.message ?? "stream error" });
        }
      })();

      poll = setInterval(async () => {
        try {
          const midTicks = (await pgFetch(
            `market_mid_ticks?select=market_id,outcome,ts,mid` +
              `&market_id=in.(${marketIds.join(",")})` +
              `&ts=gt.${encodeURIComponent(lastTickIso)}` +
              `&order=ts.asc&limit=2000`
          )) as RawTick[];

          for (const tk of midTicks) {
            if (tk.mid == null) continue;
            const dominant = dominantByMarket.get(tk.market_id);
            if (dominant && tk.outcome !== dominant) continue;
            lastTickIso = tk.ts > lastTickIso ? tk.ts : lastTickIso;
            send("tick", {
              market_id: tk.market_id,
              outcome: tk.outcome,
              ts: tk.ts,
              mid: tk.mid,
              bucketMinutes,
            });
          }

          const trades = (await pgFetch(
            `trades?select=market_id,outcome,timestamp,size,side` +
              `&market_id=in.(${marketIds.join(",")})` +
              `&timestamp=gt.${encodeURIComponent(lastTradeIso)}` +
              `&order=timestamp.asc&limit=2000`
          )) as RawTrade[];

          for (const tr of trades) {
            const dominant = dominantByMarket.get(tr.market_id);
            if (dominant && tr.outcome !== dominant) continue;
            lastTradeIso =
              tr.timestamp > lastTradeIso ? tr.timestamp : lastTradeIso;
            send("trade", {
              market_id: tr.market_id,
              outcome: tr.outcome,
              ts: tr.timestamp,
              size: toNum(tr.size ?? 0),
              side: tr.side ?? null,
              bucketMinutes,
            });
          }

          const moves = (await pgFetch(
            `market_movements?select=id,market_id,outcome,window_start,window_end,window_type,reason` +
              `&market_id=in.(${marketIds.join(",")})` +
              `&window_end=gt.${encodeURIComponent(lastMoveIso)}` +
              `&order=window_end.asc&limit=200`
          )) as RawMovement[];

          if (moves.length > 0) {
            lastMoveIso = moves[moves.length - 1].window_end;
          }

          let explanations: Record<string, string> = {};
          if (moves.length > 0) {
            try {
              const ids = moves.map((m) => m.id).join(",");
              const expRows = (await pgFetch(
                `movement_explanations?select=movement_id,text&movement_id=in.(${ids})`
              )) as { movement_id: string; text: string }[];
              explanations = Object.fromEntries(
                expRows.map((r) => [r.movement_id, r.text])
              );
            } catch {
              explanations = {};
            }
          }

          for (const mv of moves) {
            const dominant = dominantByMarket.get(mv.market_id);
            if (dominant && mv.outcome !== dominant) continue;
            send("movement", {
              ...mv,
              explanation:
                explanations[mv.id] ??
                `${mv.window_type === "event" ? "Movement" : "Signal"}: ${
                  mv.reason
                }`,
            });
          }
        } catch (err: any) {
          send("error", { message: err?.message ?? "stream error" });
        }
      }, 2000);
    },
    cancel() {
      if (stop) stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const runtime = "nodejs";

import {
  type RawTick,
  type RawTrade,
  type RawMovement,
  pgFetch,
  toNum,
  slugFromRaw,
  titleFromRaw,
  fetchDominantOutcomes,
  fetchExplanations,
} from "../../../lib/supabase";

function withMarketInExplanation(explanation: string, marketName: string): string {
  if (!marketName || !explanation) return explanation;
  return explanation.replace(
    /^(Price moved \d+%)( over )/,
    `$1 for market ${marketName}$2`
  );
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const slugsParam = searchParams.get("slugs") ?? "";
  const marketIdsParam = searchParams.get("market_id") ?? "";
  const assetIdsParam = (searchParams.get("asset_id") ?? "").trim();
  const yesOnly = searchParams.get("yesOnly") === "1";
  const eventSlugParam =
    (searchParams.get("event_slug") ?? searchParams.get("eventSlug") ?? "").trim();
  const slugList = slugsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const eventSlugList = eventSlugParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bucketMinutes = Math.max(
    1,
    Number(searchParams.get("bucketMinutes") ?? 1)
  );

  const markets = new Map<
    string,
    { slug: string; title: string; outcomes: Set<string> }
  >();

  if (marketIdsParam) {
    for (const id of marketIdsParam.split(",").map((s) => s.trim())) {
      if (!id) continue;
      markets.set(id, {
        slug: id,
        title: id,
        outcomes: new Set<string>(),
      });
    }
  } else if (slugList.length > 0) {
    const trades = await pgFetch<RawTrade[]>(
      `trades?select=market_id,outcome,timestamp,raw` +
        `&order=timestamp.desc&limit=2000`
    );
    for (const t of trades) {
      const slug = slugFromRaw(t.raw);
      if (!slug || !slugList.includes(slug)) continue;
      const title = titleFromRaw(t.raw) ?? slug;
      const entry = markets.get(t.market_id) ?? {
        slug,
        title,
        outcomes: new Set<string>(),
      };
      if (t.outcome) entry.outcomes.add(String(t.outcome));
      markets.set(t.market_id, entry);
    }
  }

  // Dedup: keep most-recent market per slug (skip when market_ids explicit or multi-market streaming)
  if (!yesOnly && !marketIdsParam && slugList.length > 0 && markets.size > 1) {
    const allIds = Array.from(markets.keys());
    const lastTickByMarket = new Map<string, number>();
    if (allIds.length > 0) {
      const ticks = await pgFetch<Pick<RawTick, "market_id" | "ts">[]>(
        `market_mid_ticks?select=market_id,ts` +
          `&market_id=in.(${allIds.join(",")})` +
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

  const marketIds = Array.from(markets.keys());
  if (marketIds.length === 0) {
    const encoder = new TextEncoder();
    const body = encoder.encode(
      `event: error\ndata: ${JSON.stringify({ message: "no markets found" })}\n\n`
    );
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const assetIds = assetIdsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const assetIdSet = assetIds.length > 0 ? new Set(assetIds) : null;
  const eventMarketIds = Array.from(
    new Set(eventSlugList.map((s) => `event:${s}`))
  );
  const eventMarketIdSet = new Set(eventMarketIds);

  const dominantByMarket = yesOnly
    ? new Map<string, string>()
    : await fetchDominantOutcomes(marketIds);

  const shouldIncludeOutcome = (marketId: string, outcome: string | null) => {
    if (eventMarketIdSet.has(marketId)) return true;
    if (yesOnly) return String(outcome ?? "").toLowerCase() === "yes";
    const dominant = dominantByMarket.get(marketId);
    if (!dominant) return true;
    return outcome === dominant;
  };

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

      const send = (event: string, data: unknown) => {
        if (closed) return;
        safeEnqueue(encoder.encode(`event: ${event}\n`));
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`: keep-alive\n\n`));
      }, 15000);

      // Initial burst: send latest tick per market+outcome (deduped)
      void (async () => {
        try {
          const latestTicks = await pgFetch<RawTick[]>(
            `market_mid_ticks?select=market_id,outcome,asset_id,ts,mid` +
              `&market_id=in.(${marketIds.join(",")})` +
              (assetIds.length > 0
                ? `&asset_id=in.(${assetIds.map(encodeURIComponent).join(",")})`
                : "") +
              `&ts=gt.${encodeURIComponent(lastTickIso)}` +
              `&order=ts.desc&limit=500`
          );

          const seen = new Set<string>();
          for (const tk of latestTicks) {
            if (tk.mid == null) continue;
            if (!shouldIncludeOutcome(tk.market_id, tk.outcome)) continue;
            if (assetIdSet && tk.asset_id && !assetIdSet.has(tk.asset_id))
              continue;
            const key = `${tk.market_id}:${tk.outcome ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            lastTickIso = tk.ts > lastTickIso ? tk.ts : lastTickIso;
            send("tick", {
              market_id: tk.market_id,
              outcome: tk.outcome,
              ts: tk.ts,
              asset_id: tk.asset_id ?? null,
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
          const midTicks = await pgFetch<RawTick[]>(
            `market_mid_ticks?select=market_id,outcome,asset_id,ts,mid` +
              `&market_id=in.(${marketIds.join(",")})` +
              (assetIds.length > 0
                ? `&asset_id=in.(${assetIds.map(encodeURIComponent).join(",")})`
                : "") +
              `&ts=gt.${encodeURIComponent(lastTickIso)}` +
              `&order=ts.asc&limit=2000`
          );

          for (const tk of midTicks) {
            if (tk.mid == null) continue;
            if (!shouldIncludeOutcome(tk.market_id, tk.outcome)) continue;
            if (assetIdSet && tk.asset_id && !assetIdSet.has(tk.asset_id))
              continue;
            lastTickIso = tk.ts > lastTickIso ? tk.ts : lastTickIso;
            send("tick", {
              market_id: tk.market_id,
              outcome: tk.outcome,
              ts: tk.ts,
              asset_id: tk.asset_id ?? null,
              mid: tk.mid,
              bucketMinutes,
            });
          }

          const trades = await pgFetch<RawTrade[]>(
            `trades?select=market_id,outcome,timestamp,size,side` +
              `&market_id=in.(${marketIds.join(",")})` +
              `&timestamp=gt.${encodeURIComponent(lastTradeIso)}` +
              `&order=timestamp.asc&limit=2000`
          );

          for (const tr of trades) {
            if (!shouldIncludeOutcome(tr.market_id, tr.outcome)) continue;
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

          const moves = await pgFetch<RawMovement[]>(
            `market_movements?select=id,market_id,outcome,window_start,window_end,window_type,reason` +
              `&market_id=in.(${Array.from(
                new Set([...marketIds, ...eventMarketIds])
              )
                .map(encodeURIComponent)
                .join(",")})` +
              `&window_end=gt.${encodeURIComponent(lastMoveIso)}` +
              `&order=window_end.asc&limit=200`
          );

          if (moves.length > 0) {
            lastMoveIso = moves[moves.length - 1].window_end;
          }

          const explanations = await fetchExplanations(
            moves.map((m) => m.id)
          );

          for (const mv of moves) {
            if (!shouldIncludeOutcome(mv.market_id, mv.outcome)) continue;
            const mvLabel = mv.window_type === "event" || mv.window_type === "5m" || mv.window_type === "15m"
              ? "Movement" : "Signal";
            const rawExplanation =
              explanations[mv.id] ??
              `${mvLabel}: ${mv.reason}`;
            const marketName = mv.market_id.startsWith("event:")
              ? mv.market_id.slice("event:".length).replace(/-/g, " ")
              : markets.get(mv.market_id)?.title ?? mv.market_id;
            const explanation = withMarketInExplanation(rawExplanation, marketName);
            send("movement", {
              ...mv,
              explanation,
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

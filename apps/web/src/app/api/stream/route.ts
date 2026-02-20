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
  resolveActiveMarketIds,
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

    // Fallback: if slug matching found nothing, resolve from recent activity
    if (markets.size === 0) {
      const active = await resolveActiveMarketIds(10);
      for (const [id, meta] of active) {
        markets.set(id, meta);
      }
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

  let marketIds = Array.from(markets.keys());
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

  // Detect binary markets (Yes/No, Up/Down, or any 2-outcome market)
  // and resolve which outcome to pin to via dominant_outcomes table.
  const BINARY_PAIRS = [["Yes", "No"], ["Up", "Down"]];
  const binaryMarketPrimary = new Map<string, string>();
  for (const [id, meta] of markets) {
    const oc = meta.outcomes;
    if (oc.size <= 2) {
      const arr = [...oc];
      // Check known binary pairs
      const pair = BINARY_PAIRS.find(
        ([a, b]) => arr.includes(a) && arr.includes(b)
      );
      if (pair) {
        // Use dominant from DB (ingestion pins to index-0), or fall back to first of pair
        binaryMarketPrimary.set(id, dominantByMarket.get(id) ?? pair[0]);
      } else if (oc.size === 0) {
        // No outcomes known yet — use dominant or default to "Yes"
        binaryMarketPrimary.set(id, dominantByMarket.get(id) ?? "Yes");
      }
    }
  }

  const shouldIncludeOutcome = (marketId: string, outcome: string | null) => {
    if (eventMarketIdSet.has(marketId)) return true;
    if (yesOnly) return String(outcome ?? "").toLowerCase() === "yes";
    // Binary markets: only show the primary outcome (index-0)
    const primary = binaryMarketPrimary.get(marketId);
    if (primary) {
      return String(outcome ?? "") === primary;
    }
    const dominant = dominantByMarket.get(marketId);
    if (!dominant) return true;
    return outcome === dominant;
  };

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let stop: (() => void) | null = null;
  let closed = false;
  let polling = false; // overlap guard
  let pollCount = 0;
  let totalTicksSent = 0;
  let emptyPolls = 0;
  let consecutiveEmptyPolls = 0;
  let errorCount = 0;
  let lastReResolveMs = 0;
  const streamStartMs = Date.now();
  const STALE_THRESHOLD = 90; // consecutive empty polls (~90s) before re-resolving

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
          console.log(
            `[stream] closed after ${((Date.now() - streamStartMs) / 1000).toFixed(0)}s` +
            ` polls=${pollCount} ticks=${totalTicksSent} empty=${emptyPolls} errors=${errorCount}`
          );
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
        } catch (err: any) {
          console.error(`[stream] enqueue error, closing:`, err?.message);
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
          let burstCount = 0;
          for (const tk of latestTicks) {
            if (tk.mid == null) continue;
            if (!shouldIncludeOutcome(tk.market_id, tk.outcome)) continue;
            if (assetIdSet && tk.asset_id && !assetIdSet.has(tk.asset_id))
              continue;
            const key = `${tk.market_id}:${tk.outcome ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            lastTickIso = tk.ts > lastTickIso ? tk.ts : lastTickIso;
            burstCount++;
            send("tick", {
              market_id: tk.market_id,
              outcome: tk.outcome,
              ts: tk.ts,
              asset_id: tk.asset_id ?? null,
              mid: tk.mid,
              bucketMinutes,
            });
          }
          totalTicksSent += burstCount;
          // Log what the stream is tracking for diagnosis
          const primaryOutcomes: string[] = [];
          for (const [id, primary] of binaryMarketPrimary) {
            primaryOutcomes.push(`${id.slice(0, 16)}→${primary}`);
          }
          console.log(
            `[stream] init: markets=[${marketIds.map((id) => id.slice(0, 16)).join(",")}]` +
            ` binaryPrimary=[${primaryOutcomes.join(",")}]` +
            ` burst=${burstCount}/${latestTicks.length} ticks, cursor=${lastTickIso}`
          );
        } catch (err: any) {
          console.error(`[stream] burst error:`, err?.message);
          send("error", { message: err?.message ?? "stream error" });
        }
      })();

      poll = setInterval(async () => {
        // Prevent overlapping polls — if previous poll is still running, skip
        if (polling) {
          console.warn(`[stream] poll overlap skipped (poll #${pollCount} still running)`);
          return;
        }
        polling = true;
        pollCount++;
        const pollStartMs = Date.now();
        const currentPoll = pollCount;

        try {
          // Use allSettled so one failed query doesn't kill the others
          const [ticksResult, tradesResult, movesResult] = await Promise.allSettled([
            pgFetch<RawTick[]>(
              `market_mid_ticks?select=market_id,outcome,asset_id,ts,mid` +
                `&market_id=in.(${marketIds.join(",")})` +
                (assetIds.length > 0
                  ? `&asset_id=in.(${assetIds.map(encodeURIComponent).join(",")})`
                  : "") +
                `&ts=gt.${encodeURIComponent(lastTickIso)}` +
                `&order=ts.asc&limit=2000`
            ),
            pgFetch<RawTrade[]>(
              `trades?select=market_id,outcome,timestamp,size,side` +
                `&market_id=in.(${marketIds.join(",")})` +
                `&timestamp=gt.${encodeURIComponent(lastTradeIso)}` +
                `&order=timestamp.asc&limit=2000`
            ),
            pgFetch<RawMovement[]>(
              `market_movements?select=id,market_id,outcome,window_start,window_end,window_type,reason` +
                `&market_id=in.(${Array.from(
                  new Set([...marketIds, ...eventMarketIds])
                )
                  .map(encodeURIComponent)
                  .join(",")})` +
                `&window_end=gt.${encodeURIComponent(lastMoveIso)}` +
                `&order=window_end.asc&limit=200`
            ),
          ]);

          // Process ticks (even if trades/moves failed)
          const midTicks = ticksResult.status === "fulfilled" ? ticksResult.value : [];
          if (ticksResult.status === "rejected") {
            errorCount++;
            console.error(`[stream] tick query failed poll #${currentPoll}:`, ticksResult.reason?.message);
          }

          let ticksSentThisPoll = 0;
          let ticksFilteredOutcome = 0;
          let ticksFilteredAsset = 0;
          let ticksFilteredNull = 0;
          for (const tk of midTicks) {
            if (tk.mid == null) { ticksFilteredNull++; continue; }
            if (!shouldIncludeOutcome(tk.market_id, tk.outcome)) { ticksFilteredOutcome++; continue; }
            if (assetIdSet && tk.asset_id && !assetIdSet.has(tk.asset_id)) { ticksFilteredAsset++; continue; }
            lastTickIso = tk.ts > lastTickIso ? tk.ts : lastTickIso;
            ticksSentThisPoll++;
            send("tick", {
              market_id: tk.market_id,
              outcome: tk.outcome,
              ts: tk.ts,
              asset_id: tk.asset_id ?? null,
              mid: tk.mid,
              bucketMinutes,
            });
          }
          totalTicksSent += ticksSentThisPoll;

          // Process trades (even if ticks/moves failed)
          const trades = tradesResult.status === "fulfilled" ? tradesResult.value : [];
          if (tradesResult.status === "rejected") {
            errorCount++;
            console.error(`[stream] trade query failed poll #${currentPoll}:`, tradesResult.reason?.message);
          }

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

          // Process movements (even if ticks/trades failed)
          const moves = movesResult.status === "fulfilled" ? movesResult.value : [];
          if (movesResult.status === "rejected") {
            errorCount++;
            console.error(`[stream] moves query failed poll #${currentPoll}:`, movesResult.reason?.message);
          }

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

          const pollMs = Date.now() - pollStartMs;
          if (ticksSentThisPoll === 0) {
            emptyPolls++;
            consecutiveEmptyPolls++;
          } else {
            consecutiveEmptyPolls = 0;
          }

          // Re-resolve market_ids from slugs when stream goes stale
          // (no ticks for STALE_THRESHOLD consecutive polls and we have slugs to re-resolve)
          if (
            consecutiveEmptyPolls >= STALE_THRESHOLD &&
            totalTicksSent > 0 &&
            slugList.length > 0 &&
            !marketIdsParam &&
            Date.now() - lastReResolveMs > 90_000
          ) {
            lastReResolveMs = Date.now();
            console.log(`[stream] stale: ${consecutiveEmptyPolls} empty polls, re-resolving slugs=[${slugList.join(",")}]`);
            try {
              const freshTrades = await pgFetch<RawTrade[]>(
                `trades?select=market_id,outcome,timestamp,raw` +
                  `&order=timestamp.desc&limit=2000`
              );
              const freshMarkets = new Map<string, { slug: string; title: string; outcomes: Set<string> }>();
              for (const t of freshTrades) {
                const slug = slugFromRaw(t.raw);
                if (!slug || !slugList.includes(slug)) continue;
                const title = titleFromRaw(t.raw) ?? slug;
                const entry = freshMarkets.get(t.market_id) ?? { slug, title, outcomes: new Set<string>() };
                if (t.outcome) entry.outcomes.add(String(t.outcome));
                freshMarkets.set(t.market_id, entry);
              }
              if (freshMarkets.size === 0) {
                const active = await resolveActiveMarketIds(10);
                for (const [id, meta] of active) freshMarkets.set(id, meta);
              }
              const newIds = Array.from(freshMarkets.keys());
              const oldSet = new Set(marketIds);
              const changed = newIds.some((id) => !oldSet.has(id));
              if (changed && newIds.length > 0) {
                marketIds = newIds;
                consecutiveEmptyPolls = 0;
                // Reset cursor to pick up recent ticks from new market
                lastTickIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
                console.log(`[stream] re-resolved: new marketIds=[${marketIds.map((id) => id.slice(0, 16)).join(",")}]`);
                send("rotate", { market_ids: marketIds });
              } else {
                console.log(`[stream] re-resolve: no change (${newIds.length} markets)`);
              }
            } catch (err: any) {
              console.error(`[stream] re-resolve error:`, err?.message);
            }
          }

          // Log diagnostic every 30 polls (~30s) or on slow polls or when ticks were filtered
          if (currentPoll % 30 === 0 || pollMs > 800 || (ticksFilteredOutcome > 0 && currentPoll <= 5)) {
            console.log(
              `[stream] poll #${currentPoll} ${pollMs}ms` +
              ` ticks: sent=${ticksSentThisPoll} fetched=${midTicks.length}` +
              ` filtered(outcome=${ticksFilteredOutcome} asset=${ticksFilteredAsset} null=${ticksFilteredNull})` +
              ` trades=${trades.length} moves=${moves.length}` +
              ` cursor=${lastTickIso}` +
              ` total=${totalTicksSent} empty=${emptyPolls} errors=${errorCount}`
            );
          }
        } catch (err: any) {
          errorCount++;
          console.error(`[stream] poll #${currentPoll} uncaught error:`, err?.message);
          send("error", { message: err?.message ?? "stream error" });
        } finally {
          polling = false;
        }
      }, 1000);
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

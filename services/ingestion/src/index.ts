import "dotenv/config";
import { connectPolymarketWS } from "./polymarket.ws";
import { connectClobMarketWS } from "./polymarket.clob.ws";

import { updateAggregateBuffered } from "../../aggregates/src/updateAggregate";
import { detectMovement } from "../../movements/src/detectMovement";
import { movementRealtime } from "../../movements/src/detectMovementRealtime";
import { insertMidTick } from "../../storage/src/insertMidTick";
import { insertTrade } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";

const assetMeta = new Map<string, { marketId: string; outcome: string | null }>();
const trackedAssets = new Set<string>();
const hydratedMarkets = new Set<string>();
const marketAssets = new Map<string, Set<string>>();
let clobWs: { close: () => void } | null = null;
let clobReconnectTimer: NodeJS.Timeout | null = null;

const lastTopByAsset = new Map<string, { bid: number; ask: number; bucket: number }>();
const MID_BUCKET_MS = 2000;
const latestSignalByAsset = new Map<string, { price: number; ts: number }>();
const lastMovementGate = new Map<string, { price: number; ts: number }>();
const MOVEMENT_MIN_MS = Number(process.env.MOVEMENT_MIN_MS ?? 10000);
const MOVEMENT_MIN_STEP = Number(process.env.MOVEMENT_MIN_STEP ?? 0.01);

async function fetchMarketAssets(opts: {
  marketId?: string | null;
  eventSlug?: string | null;
}): Promise<Array<{ assetId: string; outcome: string | null }>> {
  const base = String(process.env.POLYMARKET_MARKET_METADATA_URL ?? "").trim();
  if (!base) return [];

  let url: URL;
  if (opts.eventSlug && base.endsWith("/markets/slug")) {
    url = new URL(`${base}/${opts.eventSlug}`);
  } else if (opts.marketId && base.endsWith("/markets")) {
    url = new URL(`${base}/${opts.marketId}`);
  } else {
    url = new URL(base);
    if (opts.marketId) url.searchParams.set("conditionId", opts.marketId);
    if (opts.eventSlug) url.searchParams.set("eventSlug", opts.eventSlug);
  }

  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return [];
  const data: any = await res.json();

  const candidates: Array<{ assetId: string; outcome: string | null }> = [];

  const tokens = data?.tokens ?? data?.market?.tokens ?? data?.result?.tokens;
  if (Array.isArray(tokens)) {
    for (const t of tokens) {
      const assetId = String(t?.asset_id ?? t?.token_id ?? t?.id ?? "").trim();
      if (!assetId) continue;
      const outcome = t?.outcome != null ? String(t.outcome) : null;
      candidates.push({ assetId, outcome });
    }
  }

  const outcomes = data?.outcomes ?? data?.market?.outcomes ?? data?.result?.outcomes;
  if (Array.isArray(outcomes)) {
    for (const o of outcomes) {
      const assetId = String(o?.asset_id ?? o?.token_id ?? o?.id ?? "").trim();
      if (!assetId) continue;
      const outcome =
        o?.name != null ? String(o.name) : o?.outcome != null ? String(o.outcome) : null;
      candidates.push({ assetId, outcome });
    }
  }

  return candidates;
}

function roundPx(n: number, decimals = 3) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function shouldStoreMid(assetId: string, bestBid: number, bestAsk: number, nowMs: number) {
  const bucket = Math.floor(nowMs / MID_BUCKET_MS);
  const bid = roundPx(bestBid, 3);
  const ask = roundPx(bestAsk, 3);

  const prev = lastTopByAsset.get(assetId);
  if (!prev) {
    lastTopByAsset.set(assetId, { bid, ask, bucket });
    return true;
  }

  const changed = bid !== prev.bid || ask !== prev.ask;
  const bucketChanged = bucket !== prev.bucket;

  if (changed || bucketChanged) {
    lastTopByAsset.set(assetId, { bid, ask, bucket });
    return true;
  }
  return false;
}

function toTradeInsert(msg: any): TradeInsert | null {
  if (msg?.topic !== "activity" || msg?.type !== "trades") return null;
  const p = msg.payload;
  if (!p) return null;

  if (p.price == null || p.size == null || !p.side) return null;

  const marketId = p.conditionId;
  if (!marketId) return null;

  const id = p.transactionHash || `${marketId}:${p.asset}:${msg.timestamp}`;

  // prefer msg.timestamp (ms), fallback to payload.timestamp (sec)
  const ms =
    typeof msg.timestamp === "number"
      ? msg.timestamp
      : typeof p.timestamp === "number"
        ? p.timestamp * 1000
        : Date.parse(String(p.timestamp));

  if (!Number.isFinite(ms)) return null;

  return {
    id: String(id),
    market_id: String(marketId),
    price: Number(p.price),
    size: Number(p.size),
    side: String(p.side),
    timestamp: new Date(ms).toISOString(),
    raw: msg,
    outcome: String(p.outcome ?? ""),
    outcome_index: typeof p.outcomeIndex === "number" ? p.outcomeIndex : null,
  };
}

function bestBidFromBids(bids: any[] | undefined): number | null {
  if (!Array.isArray(bids) || bids.length === 0) return null;
  let best = -Infinity;
  for (const lvl of bids) {
    const px = Number(lvl?.price ?? lvl?.p ?? lvl?.[0]);
    if (Number.isFinite(px)) best = Math.max(best, px);
  }
  return best === -Infinity ? null : best;
}

function bestAskFromAsks(asks: any[] | undefined): number | null {
  if (!Array.isArray(asks) || asks.length === 0) return null;
  let best = Infinity;
  for (const lvl of asks) {
    const px = Number(lvl?.price ?? lvl?.p ?? lvl?.[0]);
    if (Number.isFinite(px)) best = Math.min(best, px);
  }
  return best === Infinity ? null : best;
}

export function toSyntheticMid(msg: any) {
  const assetId = String(msg?.asset_id ?? msg?.assetId ?? msg?.asset ?? "");
  if (!assetId) return null;
  const marketId = String(msg?.market ?? msg?.market_id ?? "");

  const bestBidRaw =
    msg?.best_bid != null ? Number(msg.best_bid) : bestBidFromBids(msg?.bids);
  const bestAskRaw =
    msg?.best_ask != null ? Number(msg.best_ask) : bestAskFromAsks(msg?.asks);

  const bidOk = Number.isFinite(bestBidRaw);
  const askOk = Number.isFinite(bestAskRaw);
  if (!bidOk && !askOk) return null;

  const bestBid = bidOk ? (bestBidRaw as number) : null;
  const bestAsk = askOk ? (bestAskRaw as number) : null;
  if (bestBid != null && bestAsk != null && bestBid > bestAsk) return null;

  const mid =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : bestBid != null
        ? bestBid
        : bestAsk;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const spreadPct =
    spread != null && mid != null && mid > 0 ? spread / mid : null;

  // guard: ignore garbage mid when spread is crazy wide
  if (spreadPct != null && spreadPct > 0.30) return null;

  const tsMs =
    typeof msg?.timestamp === "number"
      ? (msg.timestamp < 10_000_000_000 ? msg.timestamp * 1000 : msg.timestamp)
      : Date.now();

  if (mid != null && Number.isFinite(mid)) {
    latestSignalByAsset.set(assetId, { price: mid, ts: tsMs });
  }

  return { assetId, marketId, bestBid, bestAsk, mid, spread, spreadPct, tsMs, raw: msg };
}



console.log("[ingestion] starting...");

/**
 * 1) Activity WS: Trades
 */
const url = process.env.POLYMARKET_WS_URL;
if (!url) throw new Error("Missing POLYMARKET_WS_URL in services/ingestion/.env");

const eventSlugs = String(process.env.POLYMARKET_EVENT_SLUGS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (eventSlugs.length === 0) {
  throw new Error("Missing POLYMARKET_EVENT_SLUGS (comma-separated slugs)");
}

connectPolymarketWS({
  url,
  subscriptions: eventSlugs.map((event_slug) => ({
    topic: "activity",
    type: "trades",
    filters: JSON.stringify({ event_slug }),
  })),
  onMessage: async (msg) => {
    const trade = toTradeInsert(msg);
    if (!trade) return;

    const rawEventSlug = String((trade as any)?.raw?.payload?.eventSlug ?? "");
    const rawAssetId = String((trade as any)?.raw?.payload?.asset ?? "");
    if (rawAssetId) {
      assetMeta.set(rawAssetId, {
        marketId: trade.market_id,
        outcome: trade.outcome ? String(trade.outcome) : null,
      });
      if (!trackedAssets.has(rawAssetId)) {
        trackedAssets.add(rawAssetId);
        scheduleClobReconnect();
      }
    }

    if (!hydratedMarkets.has(trade.market_id)) {
      hydratedMarkets.add(trade.market_id);
      try {
        const assets = await fetchMarketAssets({
          marketId: trade.market_id,
          eventSlug: rawEventSlug || null,
        });
        if (assets.length > 0) {
          const set = new Set<string>();
          for (const a of assets) {
            set.add(a.assetId);
            assetMeta.set(a.assetId, {
              marketId: trade.market_id,
              outcome: a.outcome,
            });
            trackedAssets.add(a.assetId);
          }
          marketAssets.set(trade.market_id, set);
          scheduleClobReconnect();
        }
      } catch (e: any) {
        console.warn("[ingestion] hydrate market failed", e?.message ?? e);
      }
    }

    try {
      await insertTrade(trade);
      await updateAggregateBuffered(trade);

      // avoid duplicate movement signals across YES/NO
      if (trade.outcome === "Yes") {
        const gateKey = `${trade.market_id}:Yes`;
        const nowMs = Date.parse(trade.timestamp);
        const latest = rawAssetId ? latestSignalByAsset.get(rawAssetId) : undefined;
        const prev = lastMovementGate.get(gateKey);
        const enoughTime =
          !prev || !Number.isFinite(MOVEMENT_MIN_MS) || nowMs - prev.ts >= MOVEMENT_MIN_MS;
        const enoughMove =
          !prev ||
          !latest ||
          !Number.isFinite(MOVEMENT_MIN_STEP) ||
          Math.abs(latest.price - prev.price) >= MOVEMENT_MIN_STEP;

        if (!prev || (enoughTime && enoughMove)) {
          if (latest) lastMovementGate.set(gateKey, { price: latest.price, ts: nowMs });
          await detectMovement(trade);
        }
      }

      console.log(
        `[trade] ${trade.outcome} ${trade.side} px=${trade.price} sz=${trade.size}`
      );
    } catch (e: any) {
      const m = e?.message ?? "";
      if (m.includes("duplicate key value violates unique constraint")) return;
      console.error("[trade] insert failed:", m);
    }
  },
});

function scheduleClobReconnect() {
  if (clobReconnectTimer) return;
  clobReconnectTimer = setTimeout(() => {
    clobReconnectTimer = null;
    if (clobWs) clobWs.close();
    if (trackedAssets.size === 0) return;
    clobWs = connectClobMarketWS({
      assetIds: Array.from(trackedAssets),
      onTick: onClobTick,
    });
  }, 5000);
}

async function onClobTick(msg: any) {
    // Uncomment once to inspect the true message format
    // console.log("[clob raw]", JSON.stringify(msg).slice(0, 400));

    const t = toSyntheticMid(msg);
    if (!t) return;

    const meta = assetMeta.get(t.assetId);
    const marketId = t.marketId || meta?.marketId;
    const outcome = meta?.outcome ?? null;
    if (!marketId) return;

    if (outcome === "Yes" && t.mid != null && Number.isFinite(t.mid)) {
      void movementRealtime.onPriceUpdate({
        market_id: marketId,
        asset_id: t.assetId,
        outcome,
        price: t.mid,
        spreadPct: t.spreadPct,
        tsMs: t.tsMs,
        source: "mid",
      });
    }

    try {
      if (t.bestBid == null || t.bestAsk == null) return;
      if (!shouldStoreMid(t.assetId, t.bestBid, t.bestAsk, t.tsMs)) return;
      await insertMidTick({
        market_id: marketId,
        outcome,
        asset_id: t.assetId,
        ts: new Date(t.tsMs).toISOString(),
        best_bid: t.bestBid,
        best_ask: t.bestAsk,
        mid: t.mid,
        spread: t.spread,
        spread_pct: t.spreadPct,
        raw: { best_bid: t.bestBid, best_ask: t.bestAsk },
      });

      console.log(
        `[mid] ${outcome} mid=${(t.mid ?? 0).toFixed(4)} spread%=${t.spreadPct?.toFixed(4) ?? "n/a"}`
      );
    } catch (e: any) {
      console.error("[mid] insert failed:", e?.message ?? e);
    }
}

// start initial CLOB connection with any known assets (likely none)
scheduleClobReconnect();

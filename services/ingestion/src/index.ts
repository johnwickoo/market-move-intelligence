import "dotenv/config";
import { connectPolymarketWS } from "./polymarket.ws";
import { connectClobMarketWS } from "./polymarket.clob.ws";

import { updateAggregateBuffered } from "../../aggregates/src/updateAggregate";
import { detectMovement } from "../../movements/src/detectMovement";
import { movementRealtime } from "../../movements/src/detectMovementRealtime";
import { insertMidTick } from "../../storage/src/insertMidTick";
import { insertTrade } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";
import * as fs from "fs/promises";
import * as path from "path";

const assetMeta = new Map<string, { marketId: string; outcome: string | null }>();
const trackedAssets = new Set<string>();
const hydratedMarkets = new Set<string>();
const marketAssets = new Map<string, Set<string>>();
const hydrationInFlight = new Set<string>();
const clobWss: Array<{ close: () => void }> = [];
let clobReconnectTimer: NodeJS.Timeout | null = null;
const MAX_CLOB_ASSETS = Number(process.env.MAX_CLOB_ASSETS ?? 100);
const MAX_ASSETS_PER_MARKET = Number(process.env.MAX_ASSETS_PER_MARKET ?? 3);
const MOVER_WINDOW_MS = Number(process.env.MOVER_WINDOW_MS ?? 10 * 60_000);
const MOVER_REFRESH_MS = Number(process.env.MOVER_REFRESH_MS ?? 60_000);

type AssetStats = {
  firstPrice: number;
  firstTs: number;
  lastPrice: number;
  lastTs: number;
  volume: number;
  trades: number;
};

const marketSelections = new Map<string, Set<string>>();
const lastSelectionUpdate = new Map<string, number>();
const marketAssetStats = new Map<string, Map<string, AssetStats>>();

const lastTopByAsset = new Map<string, { bid: number; ask: number; bucket: number }>();
const MID_BUCKET_MS = 2000;
const latestSignalByAsset = new Map<string, { price: number; ts: number }>();
const lastMovementGate = new Map<string, { price: number; ts: number }>();
const MOVEMENT_MIN_MS = Number(process.env.MOVEMENT_MIN_MS ?? 10000);
const MOVEMENT_MIN_STEP = Number(process.env.MOVEMENT_MIN_STEP ?? 0.01);
const RETRY_MAX_ATTEMPTS = Number(process.env.RETRY_MAX_ATTEMPTS ?? 5);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 500);
const LOG_RETRY = process.env.LOG_RETRY === "1";
const INSERT_FAIL_WINDOW_MS = Number(process.env.INSERT_FAIL_WINDOW_MS ?? 60_000);
const INSERT_FAIL_THRESHOLD = Number(process.env.INSERT_FAIL_THRESHOLD ?? 3);
let insertFailCount = 0;
let insertFailWindowStart = 0;
const SPOOL_PATH = process.env.SPOOL_PATH ?? path.join("/tmp", "mmi-trade-spool.ndjson");
const SPOOL_REPLAY_MS = Number(process.env.SPOOL_REPLAY_MS ?? 30_000);
let spoolReplayRunning = false;

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttemptsOverride?: number
): Promise<T> {
  const maxAttempts =
    Number.isFinite(maxAttemptsOverride) && (maxAttemptsOverride ?? 0) > 0
      ? (maxAttemptsOverride as number)
      : Number.isFinite(RETRY_MAX_ATTEMPTS) && RETRY_MAX_ATTEMPTS > 0
        ? RETRY_MAX_ATTEMPTS
        : 5;
  const baseMs = Number.isFinite(RETRY_BASE_MS) && RETRY_BASE_MS > 0 ? RETRY_BASE_MS : 500;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt += 1;
      if (attempt >= maxAttempts) throw err;
      const jitter = Math.floor(Math.random() * 250);
      const delay = baseMs * Math.pow(2, attempt - 1) + jitter;
      if (LOG_RETRY) {
        console.warn(
          `[retry] ${label} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms`
        );
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function appendToSpool(trade: TradeInsert) {
  const line = JSON.stringify(trade) + "\n";
  await fs.appendFile(SPOOL_PATH, line, "utf8");
}

async function replaySpoolOnce() {
  if (spoolReplayRunning) return;
  spoolReplayRunning = true;
  try {
    const data = await fs.readFile(SPOOL_PATH, "utf8").catch(() => "");
    if (!data) return;
    const lines = data.split("\n").filter(Boolean);
    if (lines.length === 0) return;

    const remaining: string[] = [];
    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const trade = obj as TradeInsert;
      try {
        await insertTrade(trade);
        await updateAggregateBuffered(trade);
      } catch (e: any) {
        const m = e?.message ?? "";
        if (m.includes("duplicate key value violates unique constraint")) {
          continue;
        }
        remaining.push(line);
      }
    }

    if (remaining.length === 0) {
      await fs.writeFile(SPOOL_PATH, "", "utf8");
    } else if (remaining.length !== lines.length) {
      await fs.writeFile(SPOOL_PATH, remaining.join("\n") + "\n", "utf8");
    }
  } finally {
    spoolReplayRunning = false;
  }
}

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

  const res = await withRetry(
    () =>
      fetch(url.toString(), {
        headers: { accept: "application/json" },
      }),
    "fetchMarketAssets"
  );
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

async function hydrateMarket(marketId: string, eventSlug: string | null) {
  if (hydratedMarkets.has(marketId) || hydrationInFlight.has(marketId)) return;
  hydrationInFlight.add(marketId);
  try {
    const assets = await fetchMarketAssets({
      marketId,
      eventSlug,
    });
    if (assets.length > 0) {
      const set = new Set<string>();
      for (const a of assets) {
        set.add(a.assetId);
        assetMeta.set(a.assetId, {
          marketId,
          outcome: a.outcome,
        });
        trackedAssets.add(a.assetId);
      }
      marketAssets.set(marketId, set);
      hydratedMarkets.add(marketId);
      scheduleClobReconnect();
    }
  } catch (e: any) {
    console.warn("[ingestion] hydrate market failed", e?.message ?? e);
  } finally {
    hydrationInFlight.delete(marketId);
  }
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

function updateAssetStats(marketId: string, assetId: string, price: number, size: number, tsMs: number) {
  let byAsset = marketAssetStats.get(marketId);
  if (!byAsset) {
    byAsset = new Map();
    marketAssetStats.set(marketId, byAsset);
  }

  const stats = byAsset.get(assetId);
  if (!stats || tsMs - stats.firstTs > MOVER_WINDOW_MS) {
    byAsset.set(assetId, {
      firstPrice: price,
      firstTs: tsMs,
      lastPrice: price,
      lastTs: tsMs,
      volume: size,
      trades: 1,
    });
    return;
  }

  stats.lastPrice = price;
  stats.lastTs = tsMs;
  stats.volume += size;
  stats.trades += 1;
}

function updateSelectionForMarket(marketId: string, nowMs: number) {
  const last = lastSelectionUpdate.get(marketId) ?? 0;
  if (nowMs - last < MOVER_REFRESH_MS) return;
  lastSelectionUpdate.set(marketId, nowMs);

  const byAsset = marketAssetStats.get(marketId);
  if (!byAsset) return;

  const scored: Array<{ assetId: string; score: number }> = [];
  for (const [assetId, s] of byAsset.entries()) {
    if (s.firstPrice <= 0) continue;
    const pct = Math.abs((s.lastPrice - s.firstPrice) / s.firstPrice);
    const score = pct * Math.log10(1 + s.volume);
    scored.push({ assetId, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const limit =
    Number.isFinite(MAX_ASSETS_PER_MARKET) && MAX_ASSETS_PER_MARKET > 0
      ? MAX_ASSETS_PER_MARKET
      : 3;
  const top = new Set(scored.slice(0, limit).map((s) => s.assetId));

  // Always include "Yes" outcome if we know it for this market
  for (const [assetId, meta] of assetMeta.entries()) {
    if (meta.marketId === marketId && meta.outcome === "Yes") {
      top.add(assetId);
      break;
    }
  }

  const prev = marketSelections.get(marketId);
  let changed = !prev || prev.size !== top.size;
  if (!changed && prev) {
    for (const a of top) {
      if (!prev.has(a)) {
        changed = true;
        break;
      }
    }
  }

  if (changed) {
    marketSelections.set(marketId, top);
    trackedAssets.clear();
    for (const set of marketSelections.values()) {
      for (const a of set) trackedAssets.add(a);
    }
    scheduleClobReconnect();
  }
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

function toTradeInsertFromObj(obj: any): TradeInsert | null {
  if (!obj) return null;
  if (obj.price == null || obj.size == null || !obj.side) return null;
  const marketId = obj.conditionId ?? obj.market_id ?? obj.marketId;
  if (!marketId) return null;

  const id = obj.transactionHash || `${marketId}:${obj.asset}:${obj.timestamp}`;
  const ms =
    typeof obj.timestamp === "number"
      ? obj.timestamp * 1000
      : Date.parse(String(obj.timestamp));
  if (!Number.isFinite(ms)) return null;

  return {
    id: String(id),
    market_id: String(marketId),
    price: Number(obj.price),
    size: Number(obj.size),
    side: String(obj.side),
    timestamp: new Date(ms).toISOString(),
    raw: obj,
    outcome: String(obj.outcome ?? ""),
    outcome_index: typeof obj.outcomeIndex === "number" ? obj.outcomeIndex : null,
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
const eventSlugSet = new Set(eventSlugs);
const LOG_EVENT_SLUGS = process.env.LOG_EVENT_SLUGS === "1";
const BACKFILL_URL = String(process.env.POLYMARKET_TRADES_BACKFILL_URL ?? "").trim();
const BACKFILL_INTERVAL_MS = Number(process.env.BACKFILL_INTERVAL_MS ?? 60_000);
const BACKFILL_LOOKBACK_MS = Number(process.env.BACKFILL_LOOKBACK_MS ?? 5 * 60_000);
const BACKFILL_SILENCE_MS = Number(process.env.BACKFILL_SILENCE_MS ?? 120_000);
const MAX_BACKFILL_TRADES_PER_SLUG = Number(process.env.MAX_BACKFILL_TRADES_PER_SLUG ?? 200);
let backfillRunning = false;
const lastTradeBySlug = new Map<string, number>();

connectPolymarketWS({
  url,
  // subscribe without filters and filter locally for reliability
  subscriptions: [
    {
      topic: "activity",
      type: "trades",
    },
  ],
  onMessage: async (msg) => {
    const rawEventSlug = String((msg as any)?.payload?.eventSlug ?? "");
    if (LOG_EVENT_SLUGS && rawEventSlug) {
      console.log("[trade][slug]", rawEventSlug);
    }
    if (rawEventSlug && !eventSlugSet.has(rawEventSlug)) return;
    if (rawEventSlug) lastTradeBySlug.set(rawEventSlug, Date.now());

    const trade = toTradeInsert(msg);
    if (!trade) return;

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
      const nowMs = Date.parse(trade.timestamp);
      if (Number.isFinite(nowMs)) {
        updateAssetStats(trade.market_id, rawAssetId, Number(trade.price), Number(trade.size), nowMs);
        updateSelectionForMarket(trade.market_id, nowMs);
      }
    }

    void hydrateMarket(trade.market_id, rawEventSlug || null);

    try {
      try {
        const now = Date.now();
        if (now - insertFailWindowStart > INSERT_FAIL_WINDOW_MS) {
          insertFailWindowStart = now;
          insertFailCount = 0;
        }
        if (insertFailCount >= INSERT_FAIL_THRESHOLD) {
          await appendToSpool(trade);
          throw new Error("spooled");
        }
        await withRetry(() => insertTrade(trade), "insertTrade", 2);
        insertFailCount = 0;
      } catch {
        insertFailCount += 1;
        await appendToSpool(trade);
        throw new Error("spooled");
      }
      await withRetry(() => updateAggregateBuffered(trade), "updateAggregate");

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
          await withRetry(() => detectMovement(trade), "detectMovement");
        }
      }

      console.log(
        `[trade] ${trade.outcome} ${trade.side} px=${trade.price} sz=${trade.size}`
      );
    } catch (e: any) {
      const m = e?.message ?? "";
      if (m.includes("duplicate key value violates unique constraint")) return;
      if (m === "spooled") return;
      console.error("[trade] insert failed:", m);
    }
  },
});

async function runBackfillOnce() {
  if (!BACKFILL_URL || backfillRunning) return;
  backfillRunning = true;
  try {
    const now = Date.now();
    const sinceMs = now - BACKFILL_LOOKBACK_MS;
    for (const slug of eventSlugs) {
      const lastSeen = lastTradeBySlug.get(slug);
      if (lastSeen != null && now - lastSeen < BACKFILL_SILENCE_MS) {
        continue;
      }
      const url = new URL(BACKFILL_URL);
      url.searchParams.set("eventSlug", slug);
      url.searchParams.set("since", String(Math.floor(sinceMs / 1000)));

      const res = await withRetry(
        () =>
          fetch(url.toString(), {
            headers: { accept: "application/json" },
          }),
        "backfillFetch"
      );
      if (!res.ok) continue;
      const data: any = await res.json();

      const list =
        (Array.isArray(data) && data) ||
        data?.trades ||
        data?.data ||
        data?.result ||
        [];
      if (!Array.isArray(list)) continue;

      let kept = 0;
      for (const t of list) {
        const tSlug = String(t?.eventSlug ?? t?.slug ?? "");
        if (tSlug && tSlug !== slug) continue;
        if (
          Number.isFinite(MAX_BACKFILL_TRADES_PER_SLUG) &&
          MAX_BACKFILL_TRADES_PER_SLUG > 0 &&
          kept >= MAX_BACKFILL_TRADES_PER_SLUG
        ) {
          break;
        }
        const trade = toTradeInsertFromObj(t);
        if (!trade) continue;
        try {
          await insertTrade(trade);
          await updateAggregateBuffered(trade);
          kept += 1;
          lastTradeBySlug.set(slug, Date.parse(trade.timestamp));
        } catch (e: any) {
          const m = e?.message ?? "";
          if (m.includes("duplicate key value violates unique constraint")) continue;
        }
      }
    }
  } finally {
    backfillRunning = false;
  }
}

if (BACKFILL_URL) {
  setInterval(() => void runBackfillOnce(), BACKFILL_INTERVAL_MS);
  void runBackfillOnce();
}

setInterval(() => void replaySpoolOnce(), SPOOL_REPLAY_MS);

function chunkAssets(all: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < all.length; i += size) {
    out.push(all.slice(i, i + size));
  }
  return out;
}

function rebuildClobConnections() {
  for (const ws of clobWss) {
    try {
      ws.close();
    } catch {
      // ignore close errors
    }
  }
  clobWss.length = 0;

  if (trackedAssets.size === 0) return;
  const size = Number.isFinite(MAX_CLOB_ASSETS) && MAX_CLOB_ASSETS > 0 ? MAX_CLOB_ASSETS : 100;
  const chunks = chunkAssets(Array.from(trackedAssets), size);
  for (const assetIds of chunks) {
    const ws = connectClobMarketWS({
      assetIds,
      onTick: onClobTick,
    });
    if (ws) clobWss.push(ws);
  }
}

function scheduleClobReconnect() {
  if (clobReconnectTimer) return;
  clobReconnectTimer = setTimeout(() => {
    clobReconnectTimer = null;
    rebuildClobConnections();
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
      await withRetry(
        () =>
          insertMidTick({
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
          }),
        "insertMidTick"
      );

      if (process.env.LOG_MID === "1") {
        console.log(
          `[mid] ${outcome} mid=${(t.mid ?? 0).toFixed(4)} spread%=${t.spreadPct?.toFixed(4) ?? "n/a"}`
        );
      }
    } catch (e: any) {
      console.error("[mid] insert failed:", e?.message ?? e);
    }
}

// start initial CLOB connection with any known assets (likely none)
scheduleClobReconnect();

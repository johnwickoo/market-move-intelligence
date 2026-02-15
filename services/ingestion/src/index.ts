import "dotenv/config";

// Catch unhandled rejections with full detail instead of crashing
process.on("unhandledRejection", (reason: any) => {
  console.error("[UNHANDLED REJECTION]", typeof reason, reason instanceof Error ? reason.stack : JSON.stringify(reason, null, 2));
});

import { connectPolymarketWS } from "./polymarket.ws";
import { connectClobMarketWS, type ClobHandle } from "./polymarket.clob.ws";

import { updateAggregateBuffered } from "../../aggregates/src/updateAggregate";
import { detectMovement } from "../../movements/src/detectMovement";
import { detectEventMovement } from "../../movements/src/detectMovementEvent";
import { movementRealtime } from "../../movements/src/detectMovementRealtime";
import { insertMidTick } from "../../storage/src/insertMidTick";
import { insertTradeBatch, insertTrade, upsertDominantOutcome, upsertMarketResolution } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";
import * as fs from "fs/promises";
import * as path from "path";

const LOG_FILE = (process.env.LOG_FILE ?? path.join("/tmp", "mmi-ingestion.log")).trim();
if (LOG_FILE) {
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  let logWrite = Promise.resolve();
  const serialize = (v: any) => {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const writeLine = (level: "INFO" | "WARN" | "ERROR", args: any[]) => {
    const line =
      `[${new Date().toISOString()}] [${level}] ` +
      args.map(serialize).join(" ") +
      "\n";
    logWrite = logWrite.then(() => fs.appendFile(LOG_FILE, line, "utf8")).catch(() => {});
  };
  console.log = (...args: any[]) => {
    origLog(...args);
    writeLine("INFO", args);
  };
  console.warn = (...args: any[]) => {
    origWarn(...args);
    writeLine("WARN", args);
  };
  console.error = (...args: any[]) => {
    origError(...args);
    writeLine("ERROR", args);
  };
}

const assetMeta = new Map<string, { marketId: string; outcome: string | null }>();
const trackedAssets = new Set<string>();
const hydratedMarkets = new Set<string>();
const marketAssets = new Map<string, Set<string>>();
const marketPrimaryAsset = new Map<string, string>(); // first asset per market for realtime detector
const hydrationInFlight = new Set<string>();
const lastClobTickMs = new Map<string, number>(); // asset -> last CLOB tick timestamp
const TRADE_MID_FALLBACK_MS = 30_000; // if no CLOB tick in 30s, use trade price as mid
const resolvedSlugs = new Map<string, number>();
const marketMetaCache = new Map<string, { ts: number; meta: MarketMeta }>();
const marketResolutionById = new Map<string, { ms: number; source: string }>();
const MARKET_META_TTL_MS = Number(process.env.MARKET_META_TTL_MS ?? 10 * 60_000);
const RESOLUTION_SKEW_MS = Number(process.env.RESOLUTION_SKEW_MS ?? 5 * 60_000);
const clobWss: ClobHandle[] = [];
let clobReconnectTimer: NodeJS.Timeout | null = null;
const MAX_CLOB_ASSETS = Number(process.env.MAX_CLOB_ASSETS ?? 20);
const MAX_ASSETS_PER_MARKET = Number(process.env.MAX_ASSETS_PER_MARKET ?? 3);
const MOVER_WINDOW_MS = Number(process.env.MOVER_WINDOW_MS ?? 10 * 60_000);
const MOVER_REFRESH_MS = Number(process.env.MOVER_REFRESH_MS ?? 60_000);
const DOMINANT_OUTCOME_TTL_MS = Number(process.env.DOMINANT_OUTCOME_TTL_MS ?? 60_000);

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
const dominantOutcomeByMarket = new Map<string, { outcome: string; ts: number }>();

const lastTopByAsset = new Map<
  string,
  { bid: number | null; ask: number | null; mid: number | null; bucket: number }
>();
const MID_BUCKET_MS = 2000;
const MID_MAX_SPREAD_PCT = Number(process.env.MID_MAX_SPREAD_PCT ?? 0.30);
const LOG_MID_DEBUG = process.env.LOG_MID_DEBUG === "1";
const LOG_CLOB_RAW = process.env.LOG_CLOB_RAW === "1";
const MID_DEBUG_THROTTLE_MS = Number(process.env.MID_DEBUG_THROTTLE_MS ?? 5000);
const lastMidDebug = new Map<string, number>();
const latestSignalByAsset = new Map<string, { price: number; ts: number }>();
const lastMovementGate = new Map<string, { price: number; ts: number }>();
const MOVEMENT_MIN_MS = Number(process.env.MOVEMENT_MIN_MS ?? 10000);
const MOVEMENT_MIN_STEP = Number(process.env.MOVEMENT_MIN_STEP ?? 0.01);
const RETRY_MAX_ATTEMPTS = Number(process.env.RETRY_MAX_ATTEMPTS ?? 5);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 500);
const LOG_RETRY = process.env.LOG_RETRY === "1";
const LOG_TRADE_GROUPED = process.env.LOG_TRADE_GROUPED !== "0";
const TRADE_LOG_GROUP_MS = Number(process.env.TRADE_LOG_GROUP_MS ?? 1000);
const INSERT_FAIL_WINDOW_MS = Number(process.env.INSERT_FAIL_WINDOW_MS ?? 60_000);
const INSERT_FAIL_THRESHOLD = Number(process.env.INSERT_FAIL_THRESHOLD ?? 3);
let insertFailCount = 0;
let insertFailWindowStart = 0;
const SPOOL_PATH = process.env.SPOOL_PATH ?? path.join("/tmp", "mmi-trade-spool.ndjson");
const SPOOL_REPLAY_MS = Number(process.env.SPOOL_REPLAY_MS ?? 30_000);
let spoolReplayRunning = false;
const TRADE_BUFFER_MAX = Number(process.env.TRADE_BUFFER_MAX ?? 200);
const TRADE_BUFFER_FLUSH_MS = Number(process.env.TRADE_BUFFER_FLUSH_MS ?? 1000);
const tradeBuffer: TradeInsert[] = [];
let tradeFlushTimer: NodeJS.Timeout | null = null;
const TRADE_DEDUPE_TTL_MS = Number(process.env.TRADE_DEDUPE_TTL_MS ?? 10 * 60_000);
const recentTrades = new Map<string, number>();
const pendingTradeLogs = new Map<string, { parts: string[]; timer: NodeJS.Timeout }>();

function logMidDebug(key: string, ...args: any[]) {
  if (!LOG_MID_DEBUG) return;
  const now = Date.now();
  const last = lastMidDebug.get(key) ?? 0;
  if (now - last < MID_DEBUG_THROTTLE_MS) return;
  lastMidDebug.set(key, now);
  console.log(...args);
}

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

async function appendManyToSpool(trades: TradeInsert[]) {
  if (trades.length === 0) return;
  const lines = trades.map((t) => JSON.stringify(t)).join("\n") + "\n";
  await fs.appendFile(SPOOL_PATH, lines, "utf8");
}

type MarketMeta = {
  marketId: string | null;
  slug: string | null;
  assets: Array<{ assetId: string; outcome: string | null }>;
  resolvedAtMs: number | null;
  endTimeMs: number | null;
  status: string | null;
  resolvedFlag: boolean | null;
  resolvedSource: string | null;
  endSource: string | null;
};

const RESOLUTION_KEYS = [
  "resolved_at",
  "resolvedAt",
  "resolved_time",
  "resolvedTime",
  "resolution_time",
  "resolutionTime",
  "resolution_date",
  "resolutionDate",
  "settlement_time",
  "settlementTime",
];

const END_TIME_KEYS = [
  "end_date",
  "endDate",
  "end_time",
  "endTime",
  "close_time",
  "closeTime",
  "close_date",
  "closeDate",
  "expiration",
  "expires_at",
  "expiresAt",
  "event_end",
  "eventEnd",
];

const STATUS_KEYS = ["status", "state", "market_status", "marketState", "phase"];
const RESOLVED_FLAG_KEYS = [
  "resolved",
  "isResolved",
  "is_resolved",
  "settled",
  "isSettled",
  "closed",
  "isClosed",
  "is_closed",
];

function collectRoots(data: any): any[] {
  const roots: any[] = [];
  if (data && typeof data === "object") roots.push(data);
  const nested = [
    data?.data,
    data?.payload,
    data?.result,
    data?.market,
    data?.event,
    data?.market?.event,
  ];
  for (const item of nested) {
    if (item && typeof item === "object") roots.push(item);
  }
  return roots;
}

function parseTimestamp(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      return n < 10_000_000_000 ? n * 1000 : n;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractTimeFromRoots(
  roots: any[],
  keys: string[]
): { ms: number; key: string } | null {
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of keys) {
      if (root[key] == null) continue;
      const ms = parseTimestamp(root[key]);
      if (ms != null) return { ms, key };
    }
  }
  return null;
}

function extractStatusFromRoots(
  roots: any[]
): { status: string | null; resolvedFlag: boolean | null } {
  let status: string | null = null;
  let resolvedFlag: boolean | null = null;
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of STATUS_KEYS) {
      if (status == null && typeof root[key] === "string") {
        status = String(root[key]);
      }
    }
    for (const key of RESOLVED_FLAG_KEYS) {
      if (typeof root[key] === "boolean") {
        resolvedFlag = root[key];
      }
    }
    if (typeof root.active === "boolean" && root.active === false) {
      resolvedFlag = true;
    }
  }
  return { status, resolvedFlag };
}

function extractMarketIdFromRoots(roots: any[]): string | null {
  const idKeys = ["conditionId", "marketId", "market_id", "id", "market"];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of idKeys) {
      const val = root[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  }
  return null;
}

function extractSlugFromRoots(roots: any[]): string | null {
  const slugKeys = ["eventSlug", "slug", "marketSlug", "market_slug"];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of slugKeys) {
      const val = root[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  }
  return null;
}

function tryParseJsonArray(value: unknown): any[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

function extractAssetsFromMeta(data: any): Array<{ assetId: string; outcome: string | null }> {
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

  // Handle clobTokenIds + outcomes as parallel arrays (Polymarket slug API format).
  // The gamma API returns these as JSON-encoded strings, not native arrays.
  const rawClobTokenIds =
    data?.clobTokenIds ?? data?.market?.clobTokenIds ?? data?.result?.clobTokenIds;
  const rawOutcomeNames =
    data?.outcomes ?? data?.market?.outcomes ?? data?.result?.outcomes;
  const clobTokenIds = tryParseJsonArray(rawClobTokenIds);
  const outcomeNames = tryParseJsonArray(rawOutcomeNames);
  if (clobTokenIds && clobTokenIds.length > 0 && candidates.length === 0) {
    for (let i = 0; i < clobTokenIds.length; i++) {
      const assetId = String(clobTokenIds[i] ?? "").trim();
      if (!assetId) continue;
      const outcome =
        outcomeNames && outcomeNames[i] != null
          ? String(outcomeNames[i])
          : null;
      candidates.push({ assetId, outcome });
    }
  }

  // Legacy: outcomes as objects with asset_id/token_id fields
  if (candidates.length === 0 && outcomeNames) {
    for (const o of outcomeNames) {
      if (typeof o !== "object" || o === null) continue;
      const assetId = String(o?.asset_id ?? o?.token_id ?? o?.id ?? "").trim();
      if (!assetId) continue;
      const outcome =
        o?.name != null ? String(o.name) : o?.outcome != null ? String(o.outcome) : null;
      candidates.push({ assetId, outcome });
    }
  }

  return candidates;
}

function extractMarketMeta(data: any): MarketMeta {
  const roots = collectRoots(data);
  const resolved = extractTimeFromRoots(roots, RESOLUTION_KEYS);
  const end = extractTimeFromRoots(roots, END_TIME_KEYS);
  const { status, resolvedFlag } = extractStatusFromRoots(roots);
  const marketId = extractMarketIdFromRoots(roots);
  const slug = extractSlugFromRoots(roots);
  const assets = extractAssetsFromMeta(data);

  return {
    marketId,
    slug,
    assets,
    resolvedAtMs: resolved?.ms ?? null,
    endTimeMs: end?.ms ?? null,
    status,
    resolvedFlag,
    resolvedSource: resolved?.key ?? null,
    endSource: end?.key ?? null,
  };
}

function isMetaResolved(meta: MarketMeta, nowMs: number): boolean {
  if (meta.resolvedFlag === true) return true;
  if (meta.status) {
    const s = meta.status.toLowerCase();
    if (["resolved", "closed", "settled", "ended"].includes(s)) return true;
  }
  if (meta.resolvedAtMs != null && meta.resolvedAtMs <= nowMs + RESOLUTION_SKEW_MS) {
    return true;
  }
  if (meta.endTimeMs != null && meta.endTimeMs <= nowMs + RESOLUTION_SKEW_MS) {
    return true;
  }
  return false;
}

function persistMarketResolution(meta: MarketMeta, source: string) {
  if (!meta.marketId) return;
  const hasSignal =
    meta.resolvedAtMs != null ||
    meta.endTimeMs != null ||
    meta.status != null ||
    meta.resolvedFlag != null;
  if (!hasSignal) return;

  const resolved =
    meta.resolvedFlag === true ||
    (meta.status ? ["resolved", "closed", "settled", "ended"].includes(meta.status.toLowerCase()) : false) ||
    (meta.resolvedAtMs != null && meta.resolvedAtMs <= Date.now() + RESOLUTION_SKEW_MS) ||
    (meta.endTimeMs != null && meta.endTimeMs <= Date.now() + RESOLUTION_SKEW_MS);

  const resolved_at = meta.resolvedAtMs != null ? new Date(meta.resolvedAtMs).toISOString() : null;
  const end_time = meta.endTimeMs != null ? new Date(meta.endTimeMs).toISOString() : null;

  const resolvedSource = meta.resolvedSource ? `${source}:${meta.resolvedSource}` : null;
  const endSource = meta.endSource ? `${source}:${meta.endSource}` : null;

  void withRetry(
    () =>
      upsertMarketResolution({
        market_id: meta.marketId!,
        slug: meta.slug,
        resolved_at,
        end_time,
        resolved,
        status: meta.status,
        resolved_source: resolvedSource,
        end_source: endSource,
        updated_at: new Date().toISOString(),
      }),
    "upsertMarketResolution"
  ).catch((err: any) => {
    console.warn(
      "[resolution] upsert failed",
      { market: meta.marketId?.slice(0, 12), slug: meta.slug ?? "-" },
      err?.message ?? err
    );
  });
}

function noteResolutionFromMessage(msg: any, source: string) {
  const roots = collectRoots(msg);
  const marketId = extractMarketIdFromRoots(roots);
  if (!marketId) return;
  const resolved = extractTimeFromRoots(roots, RESOLUTION_KEYS);
  const end = extractTimeFromRoots(roots, END_TIME_KEYS);
  const picked = resolved ?? end;
  if (!picked) return;
  const prev = marketResolutionById.get(marketId);
  if (!prev || picked.ms < prev.ms) {
    marketResolutionById.set(marketId, { ms: picked.ms, source: `${source}:${picked.key}` });
    console.log(
      `[resolution] source=${source} market=${marketId.slice(0, 12)} time=${new Date(picked.ms).toISOString()} field=${picked.key}`
    );
  }
  const meta = extractMarketMeta(msg);
  const metaWithId = meta.marketId ? meta : { ...meta, marketId };
  persistMarketResolution(metaWithId, source);
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

async function flushTradeBuffer() {
  if (tradeBuffer.length === 0) return;
  const batch = tradeBuffer.splice(0, tradeBuffer.length);
  console.log(`[trade-batch] flush size=${batch.length}`);
  try {
    if (insertFailCount >= INSERT_FAIL_THRESHOLD) {
      await appendManyToSpool(batch);
      console.log(`[trade-batch] spooled size=${batch.length} reason=circuit`);
      return;
    }
    await withRetry(() => insertTradeBatch(batch), "insertTradeBatch", 2);
    insertFailCount = 0;
    console.log(`[trade-batch] success size=${batch.length}`);
  } catch (err: any) {
    insertFailCount += 1;
    await appendManyToSpool(batch);
    console.log(`[trade-batch] failed size=${batch.length} -> spooled:`, err?.message ?? err);
  }
}

async function fetchMarketMeta(opts: {
  marketId?: string | null;
  eventSlug?: string | null;
}): Promise<MarketMeta | null> {
  const base = String(process.env.POLYMARKET_MARKET_METADATA_URL ?? "").trim();
  if (!base) return null;

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
  if (!res.ok) return null;
  const raw: any = await res.json();
  let data: any = raw;
  if (Array.isArray(raw)) {
    data = raw[0] ?? null;
  } else if (Array.isArray(raw?.markets)) {
    data = raw.markets[0] ?? null;
  } else if (Array.isArray(raw?.data)) {
    data = raw.data[0] ?? null;
  } else if (Array.isArray(raw?.result)) {
    data = raw.result[0] ?? null;
  }
  if (!data) return null;
  return extractMarketMeta(data);
}

async function fetchMarketAssets(opts: {
  marketId?: string | null;
  eventSlug?: string | null;
}): Promise<Array<{ assetId: string; outcome: string | null }>> {
  const meta = await fetchMarketMeta(opts);
  return meta?.assets ?? [];
}

async function fetchEventChildMarkets(slug: string): Promise<MarketMeta[] | null> {
  const base = String(process.env.POLYMARKET_MARKET_METADATA_URL ?? "").trim();
  if (!base) return null;
  // Derive events API URL: /markets/slug → /events/slug
  const eventsUrl = base.replace(/\/markets\/slug$/, "/events/slug");
  if (eventsUrl === base) return null;

  try {
    const res = await withRetry(
      () => fetch(`${eventsUrl}/${slug}`, { headers: { accept: "application/json" } }),
      "fetchEventChildMarkets"
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const markets = data?.markets;
    if (!Array.isArray(markets) || markets.length === 0) return null;
    console.log(`[event-meta] ${slug}: found ${markets.length} child markets`);
    return markets.map((m: any) => extractMarketMeta(m));
  } catch (err: any) {
    console.warn(`[event-meta] ${slug} fetch failed:`, err?.message ?? err);
    return null;
  }
}

async function hydrateMarket(marketId: string, eventSlug: string | null) {
  if (hydratedMarkets.has(marketId)) { return; }
  if (hydrationInFlight.has(marketId)) { return; }

  // For multi-market event children, use the child's own slug for metadata lookup
  const childSlug = childMarketSlugById.get(marketId.toLowerCase());
  const slugForMeta = childSlug ?? eventSlug;
  const isMultiMarketChild = !!childSlug;

  console.log("[hydrate] starting", marketId.slice(0, 12), "slug=", slugForMeta);
  hydrationInFlight.add(marketId);
  try {
    const meta = await fetchMarketMeta({
      marketId,
      eventSlug: slugForMeta,
    });
    if (meta) {
      const enriched = slugForMeta && !meta.slug ? { ...meta, slug: slugForMeta } : meta;
      persistMarketResolution(enriched, "metadata");
    }
    const assets = meta?.assets ?? [];
    if (meta && isMetaResolved(meta, Date.now())) {
      const ts = meta.resolvedAtMs ?? meta.endTimeMs ?? Date.now();
      // Don't mark the parent event slug as resolved when a single child is resolved
      if (eventSlug && !isMultiMarketChild) {
        resolvedSlugs.set(eventSlug, ts);
        removeTrackedSlug(eventSlug);
      }
      cleanupResolvedMarket(meta);
      console.log(
        `[hydrate] skipped resolved market=${marketId.slice(0, 12)} slug=${slugForMeta ?? "-"} resolved_at=${new Date(ts).toISOString()}`
      );
      return;
    }
    console.log("[hydrate]", marketId.slice(0, 12), "slug=", slugForMeta, "assets=", assets.length, assets.map(a => `${a.assetId.slice(0, 12)}…(${a.outcome})`));
    // Always mark hydrated after a successful metadata fetch to avoid re-calling
    // the API on every trade. Assets may also arrive via the trade stream.
    hydratedMarkets.add(marketId);
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
      if (!marketPrimaryAsset.has(marketId)) {
        marketPrimaryAsset.set(marketId, assets[0].assetId);
      }
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

function shouldStoreMid(
  assetId: string,
  bestBid: number | null,
  bestAsk: number | null,
  mid: number | null,
  nowMs: number
) {
  const bucket = Math.floor(nowMs / MID_BUCKET_MS);
  const bid = bestBid != null ? roundPx(bestBid, 3) : null;
  const ask = bestAsk != null ? roundPx(bestAsk, 3) : null;
  const m = mid != null ? roundPx(mid, 3) : null;

  const prev = lastTopByAsset.get(assetId);
  if (!prev) {
    lastTopByAsset.set(assetId, { bid, ask, mid: m, bucket });
    return true;
  }

  const changed = bid !== prev.bid || ask !== prev.ask || m !== prev.mid;
  const bucketChanged = bucket !== prev.bucket;

  if (changed || bucketChanged) {
    lastTopByAsset.set(assetId, { bid, ask, mid: m, bucket });
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
    // Preserve all hydrated assets (from marketAssets) so multi-market
    // children aren't wiped when a single market triggers selection update
    for (const set of marketAssets.values()) {
      for (const a of set) trackedAssets.add(a);
    }
    // Layer selection-based assets on top (may overlap)
    for (const set of marketSelections.values()) {
      for (const a of set) trackedAssets.add(a);
    }
    scheduleClobReconnect();
  }
}

function getDominantOutcome(marketId: string, nowMs: number): string | null {
  const cached = dominantOutcomeByMarket.get(marketId);
  if (cached && nowMs - cached.ts < DOMINANT_OUTCOME_TTL_MS) return cached.outcome;

  const byAsset = marketAssetStats.get(marketId);
  if (!byAsset) return null;

  let bestAsset: string | null = null;
  let bestVolume = -1;
  let bestTrades = -1;

  for (const [assetId, s] of byAsset.entries()) {
    if (nowMs - s.lastTs > MOVER_WINDOW_MS) continue;
    if (s.volume > bestVolume || (s.volume === bestVolume && s.trades > bestTrades)) {
      bestVolume = s.volume;
      bestTrades = s.trades;
      bestAsset = assetId;
    }
  }

  if (!bestAsset) return null;
  const meta = assetMeta.get(bestAsset);
  const outcome = meta?.outcome ?? null;
  if (!outcome) return null;
  dominantOutcomeByMarket.set(marketId, { outcome, ts: nowMs });
  void withRetry(
    () => upsertDominantOutcome(marketId, outcome, new Date(nowMs).toISOString()),
    "upsertDominantOutcome"
  ).catch((err) => {
    console.warn(
      "[dominant] upsert failed",
      { market: marketId.slice(0, 12), outcome },
      err?.message ?? err
    );
  });
  return outcome;
}

function toTradeInsert(msg: any): TradeInsert | null {
  if (msg?.topic !== "activity" || msg?.type !== "trades") return null;
  const p = msg.payload;
  if (!p) return null;

  if (p.price == null || p.size == null || !p.side) return null;

  const marketId = p.conditionId;
  if (!marketId) return null;

  const tx = p.transactionHash ? String(p.transactionHash) : "";
  const assetId = p.asset ? String(p.asset) : "";
  const id = tx ? `${tx}:${assetId}` : `${marketId}:${assetId}:${msg.timestamp}`;

  // prefer msg.timestamp (ms), fallback to payload.timestamp (sec)
  const ms =
    typeof msg.timestamp === "number"
      ? msg.timestamp
      : typeof p.timestamp === "number"
        ? p.timestamp < 10_000_000_000
          ? p.timestamp * 1000
          : p.timestamp
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

  const tx = obj.transactionHash ? String(obj.transactionHash) : "";
  const assetId = obj.asset ? String(obj.asset) : "";
  const id = tx ? `${tx}:${assetId}` : `${marketId}:${assetId}:${obj.timestamp}`;
  const ms =
    typeof obj.timestamp === "number"
      ? obj.timestamp < 10_000_000_000
        ? obj.timestamp * 1000
        : obj.timestamp
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

function isDuplicateTrade(id: string, nowMs: number): boolean {
  const last = recentTrades.get(id);
  if (last != null && nowMs - last < TRADE_DEDUPE_TTL_MS) return true;
  recentTrades.set(id, nowMs);
  if (recentTrades.size > 50_000) {
    for (const [k, v] of recentTrades.entries()) {
      if (nowMs - v > TRADE_DEDUPE_TTL_MS) recentTrades.delete(k);
    }
  }
  return false;
}

function logGroupedTrade(
  tx: string,
  part: string
) {
  if (!LOG_TRADE_GROUPED || !tx) {
    console.log(part);
    return;
  }
  const existing = pendingTradeLogs.get(tx);
  if (existing) {
    existing.parts.push(part);
    return;
  }
  const timer = setTimeout(() => {
    const item = pendingTradeLogs.get(tx);
    if (!item) return;
    pendingTradeLogs.delete(tx);
    console.log(`[trade] tx=${tx} ${item.parts.join(" | ")}`);
  }, TRADE_LOG_GROUP_MS);
  pendingTradeLogs.set(tx, { parts: [part], timer });
}

function bestBidFromBids(bids: any[] | undefined): number | null {
  return bestBidLevelFromBids(bids)?.price ?? null;
}

function bestAskFromAsks(asks: any[] | undefined): number | null {
  return bestAskLevelFromAsks(asks)?.price ?? null;
}

function bestBidLevelFromBids(
  bids: any[] | undefined
): { price: number; size: number } | null {
  if (!Array.isArray(bids) || bids.length === 0) return null;
  let bestPrice = -Infinity;
  let bestSize = 0;
  for (const lvl of bids) {
    const px = Number(lvl?.price ?? lvl?.p ?? lvl?.[0]);
    if (!Number.isFinite(px)) continue;
    if (px > bestPrice) {
      bestPrice = px;
      const sz = Number(lvl?.size ?? lvl?.s ?? lvl?.[1]);
      bestSize = Number.isFinite(sz) ? sz : 0;
    }
  }
  return bestPrice === -Infinity ? null : { price: bestPrice, size: bestSize };
}

function bestAskLevelFromAsks(
  asks: any[] | undefined
): { price: number; size: number } | null {
  if (!Array.isArray(asks) || asks.length === 0) return null;
  let bestPrice = Infinity;
  let bestSize = 0;
  for (const lvl of asks) {
    const px = Number(lvl?.price ?? lvl?.p ?? lvl?.[0]);
    if (!Number.isFinite(px)) continue;
    if (px < bestPrice) {
      bestPrice = px;
      const sz = Number(lvl?.size ?? lvl?.s ?? lvl?.[1]);
      bestSize = Number.isFinite(sz) ? sz : 0;
    }
  }
  return bestPrice === Infinity ? null : { price: bestPrice, size: bestSize };
}

export function toSyntheticMid(msg: any) {
  const payload = msg?.data ?? msg?.payload ?? msg?.result ?? msg;
  const assetId = String(
    payload?.asset_id ??
      payload?.assetId ??
      payload?.asset ??
      msg?.asset_id ??
      msg?.assetId ??
      msg?.asset ??
      ""
  ).trim();
  if (!assetId) {
    logMidDebug("mid:missing-asset", "[mid] drop: missing asset id", Object.keys(msg ?? {}));
    return null;
  }
  const marketId = String(
    payload?.market ??
      payload?.market_id ??
      payload?.marketId ??
      msg?.market ??
      msg?.market_id ??
      msg?.marketId ??
      ""
  ).trim();

  const bids = payload?.bids ?? payload?.orderbook?.bids ?? msg?.bids ?? msg?.orderbook?.bids;
  const asks = payload?.asks ?? payload?.orderbook?.asks ?? msg?.asks ?? msg?.orderbook?.asks;
  const bidLevel = bestBidLevelFromBids(bids);
  const askLevel = bestAskLevelFromAsks(asks);
  const bestBidRaw =
    payload?.best_bid != null
      ? Number(payload.best_bid)
      : msg?.best_bid != null
        ? Number(msg.best_bid)
        : bidLevel?.price;
  const bestAskRaw =
    payload?.best_ask != null
      ? Number(payload.best_ask)
      : msg?.best_ask != null
        ? Number(msg.best_ask)
        : askLevel?.price;
  const bestBidSize =
    payload?.best_bid_size != null
      ? Number(payload.best_bid_size)
      : msg?.best_bid_size != null
        ? Number(msg.best_bid_size)
        : bidLevel?.size ?? null;
  const bestAskSize =
    payload?.best_ask_size != null
      ? Number(payload.best_ask_size)
      : msg?.best_ask_size != null
        ? Number(msg.best_ask_size)
        : askLevel?.size ?? null;

  const bidOk = Number.isFinite(bestBidRaw);
  const askOk = Number.isFinite(bestAskRaw);
  if (!bidOk && !askOk) {
    logMidDebug(`mid:no-bbo:${assetId}`, "[mid] drop: no bid/ask", { assetId });
    return null;
  }

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
  const maxSpread = Number.isFinite(MID_MAX_SPREAD_PCT) ? MID_MAX_SPREAD_PCT : 0.30;
  if (maxSpread > 0 && spreadPct != null && spreadPct > maxSpread) {
    logMidDebug(`mid:spread:${assetId}`, "[mid] drop: wide spread", {
      assetId,
      spreadPct,
      mid,
      bestBid,
      bestAsk,
    });
    return null;
  }

  const tsRaw = payload?.timestamp ?? msg?.timestamp;
  let tsMs = Date.now();
  if (typeof tsRaw === "number") {
    tsMs = tsRaw < 10_000_000_000 ? tsRaw * 1000 : tsRaw;
  } else if (typeof tsRaw === "string") {
    const n = Number(tsRaw);
    if (Number.isFinite(n)) {
      tsMs = n < 10_000_000_000 ? n * 1000 : n;
    } else {
      const parsed = Date.parse(tsRaw);
      if (Number.isFinite(parsed)) tsMs = parsed;
    }
  }

  if (mid != null && Number.isFinite(mid)) {
    latestSignalByAsset.set(assetId, { price: mid, ts: tsMs });
  }

  return {
    assetId,
    marketId,
    bestBid,
    bestAsk,
    bestBidSize,
    bestAskSize,
    mid,
    spread,
    spreadPct,
    tsMs,
    raw: msg,
  };
}

console.log("[ingestion] starting...");

// #region agent log
fetch('http://127.0.0.1:7243/ingest/a2ce0bcd-2fd9-4a62-b9b6-9bec63aa6bf3', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    location: 'services/ingestion/src/index.ts:startup',
    message: 'ingestion startup',
    runId: 'pre-fix',
    hypothesisId: 'H4',
    data: {
      hasWsUrl: !!process.env.POLYMARKET_WS_URL,
    },
  }),
}).catch(() => {});
// #endregion agent log

/**
 * 1) Activity WS: Trades
 */
const url = process.env.POLYMARKET_WS_URL;
if (!url) {
  // #region agent log
  fetch('http://127.0.0.1:7243/ingest/a2ce0bcd-2fd9-4a62-b9b6-9bec63aa6bf3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      location: 'services/ingestion/src/index.ts:missing-ws-url',
      message: 'POLYMARKET_WS_URL missing at startup',
      runId: 'pre-fix',
      hypothesisId: 'H5',
      data: {},
    }),
  }).catch(() => {});
  // #endregion agent log
  throw new Error("Missing POLYMARKET_WS_URL in services/ingestion/.env");
}

// When true, only the slug from Supabase tracked_slugs is used (frontend is source of truth).
const TRACK_SINGLE_SLUG = process.env.TRACK_SINGLE_SLUG !== "0";

let eventSlugs: string[];
const eventSlugSet = new Set<string>();
if (TRACK_SINGLE_SLUG) {
  // Single-slug mode: do not seed from env; syncTrackedSlugs will populate from DB (frontend).
  eventSlugs = [];
} else {
  eventSlugs = String(process.env.POLYMARKET_EVENT_SLUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of eventSlugs) eventSlugSet.add(s);
}
const trackedMarketIdBySlug = new Map<string, string>();
const allMarketIdsBySlug = new Map<string, string[]>(); // event slug → all child conditionIds (multi-market events)
const childMarketSlugById = new Map<string, string>();   // conditionId → child market's own slug (for hydration)
const childMarketEventSlugById = new Map<string, string>(); // conditionId → event slug (multi-market)
const trackedMarketIds = new Set<string>();
const LOG_TRADE_DEBUG = process.env.LOG_TRADE_DEBUG === "1";
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
  staleMs: Number(process.env.WS_STALE_MS ?? 60_000),
  staleCheckMs: Number(process.env.WS_STALE_CHECK_MS ?? 10_000),
  onMessage: async (msg) => {
    // ── fast-path filter: drop unrelated trades before any work ──
    const payload = (msg as any)?.payload ?? msg;
    const rawMarketId = String(
      payload?.conditionId ?? payload?.market_id ?? payload?.marketId ?? ""
    ).trim().toLowerCase();

    if (TRACK_SINGLE_SLUG || eventSlugSet.size > 0 || trackedMarketIds.size > 0) {
      // Quick market-ID check first (cheapest)
      const hasTrackedMarket = rawMarketId && trackedMarketIds.has(rawMarketId);
      if (!hasTrackedMarket) {
        // Fall back to slug check
        let hasTrackedSlug = false;
        const slugFields = [
          payload?.eventSlug,
          payload?.slug,
          payload?.marketSlug,
          payload?.market_slug,
          payload?.event_slug,
        ];
        for (const s of slugFields) {
          if (typeof s === "string" && s.trim() && eventSlugSet.has(s.trim())) {
            hasTrackedSlug = true;
            break;
          }
        }
        if (!hasTrackedSlug) return;
      }
    }

    noteResolutionFromMessage(msg, "ws");

    // Build slug candidates for matched trades (used downstream for hydration)
    const slugCandidates = new Set<string>();
    for (const s of [payload?.eventSlug, payload?.slug, payload?.marketSlug, payload?.market_slug, payload?.event_slug]) {
      if (typeof s === "string" && s.trim()) slugCandidates.add(s.trim());
    }

    if (slugCandidates.size > 0) {
      const now = Date.now();
      for (const s of slugCandidates) {
        if (eventSlugSet.has(s)) lastTradeBySlug.set(s, now);
      }
    }

    const trade = toTradeInsert(msg);
    if (!trade) return;
    const tradeTsMs = Date.parse(trade.timestamp);
    if (Number.isFinite(tradeTsMs) && isDuplicateTrade(trade.id, tradeTsMs)) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/a2ce0bcd-2fd9-4a62-b9b6-9bec63aa6bf3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          location: 'services/ingestion/src/index.ts:onMessage:duplicate-skip',
          message: 'trade skipped as duplicate',
          runId: 'pre-fix',
          hypothesisId: 'H6',
          data: {
            tradeId: trade.id,
            tradeTsMs,
          },
        }),
      }).catch(() => {});
      // #endregion agent log
      return;
    }

    const rawAssetId = String((trade as any)?.raw?.payload?.asset ?? "");
    if (rawAssetId) {
      assetMeta.set(rawAssetId, {
        marketId: trade.market_id,
        outcome: trade.outcome ? String(trade.outcome) : null,
      });
      if (Number.isFinite(tradeTsMs)) {
        movementRealtime.onTrade(trade.market_id, rawAssetId, tradeTsMs);
      }
      if (!trackedAssets.has(rawAssetId)) {
        trackedAssets.add(rawAssetId);
        if (!marketPrimaryAsset.has(trade.market_id)) {
          marketPrimaryAsset.set(trade.market_id, rawAssetId);
        }
        scheduleClobReconnect();
      }
      const nowMs = Date.parse(trade.timestamp);
      if (Number.isFinite(nowMs)) {
        updateAssetStats(trade.market_id, rawAssetId, Number(trade.price), Number(trade.size), nowMs);
        updateSelectionForMarket(trade.market_id, nowMs);

        // Trade-price fallback: if CLOB hasn't sent data for this asset recently,
        // generate a mid tick from the trade price so the chart has data.
        const lastClob = lastClobTickMs.get(rawAssetId) ?? 0;
        if (nowMs - lastClob > TRADE_MID_FALLBACK_MS) {
          const tradePrice = Number(trade.price);
          if (Number.isFinite(tradePrice) && tradePrice > 0) {
            const outcome = trade.outcome ? String(trade.outcome) : null;
            if (shouldStoreMid(rawAssetId, null, null, tradePrice, nowMs)) {
              withRetry(
                () =>
                  insertMidTick({
                    market_id: trade.market_id,
                    outcome,
                    asset_id: rawAssetId,
                    ts: new Date(nowMs).toISOString(),
                    best_bid: null,
                    best_ask: null,
                    mid: tradePrice,
                    spread: null,
                    spread_pct: null,
                    raw: { source: "trade_fallback", price: tradePrice },
                  }),
                "insertMidTick:tradeFallback"
              ).then(() => {
                if (process.env.LOG_MID === "1") {
                  console.log(`[mid:trade-fallback] market=${trade.market_id.slice(0, 12)} outcome=${outcome} mid=${tradePrice.toFixed(4)}`);
                }
              }).catch(() => {});
            }
          }
        }
      }
    }

    const hydrateSlug = slugCandidates.size > 0 ? Array.from(slugCandidates)[0] : null;
    void hydrateMarket(trade.market_id, hydrateSlug);

    try {
      const now = Date.now();
      if (now - insertFailWindowStart > INSERT_FAIL_WINDOW_MS) {
        insertFailWindowStart = now;
        insertFailCount = 0;
      }

      tradeBuffer.push(trade);
      if (tradeBuffer.length >= TRADE_BUFFER_MAX) {
        void flushTradeBuffer();
      } else if (!tradeFlushTimer) {
        tradeFlushTimer = setTimeout(() => {
          tradeFlushTimer = null;
          void flushTradeBuffer();
        }, TRADE_BUFFER_FLUSH_MS);
      }
      await withRetry(() => updateAggregateBuffered(trade), "updateAggregate");
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/a2ce0bcd-2fd9-4a62-b9b6-9bec63aa6bf3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          location: 'services/ingestion/src/index.ts:onMessage:processed',
          message: 'trade processed successfully',
          runId: 'pre-fix',
          hypothesisId: 'H7',
          data: {
            tradeId: trade.id,
            marketId: trade.market_id,
            price: trade.price,
            size: trade.size,
          },
        }),
      }).catch(() => {});
      // #endregion agent log

      const nowMs = Date.parse(trade.timestamp);
      if (Number.isFinite(nowMs)) {
        const eventSlug = resolveEventSlugForMarket(trade.market_id, slugCandidates);
        if (eventSlug) {
          const childIds = allMarketIdsBySlug.get(eventSlug);
          if (childIds && childIds.length >= 2) {
            void withRetry(
              () => detectEventMovement({ eventSlug, childMarketIds: childIds, nowMs }),
              "detectEventMovement",
              2
            ).catch((err: any) => {
              console.warn("[movement-event] detect failed", err?.message ?? err);
            });
          }
        }
      }

      // avoid duplicate movement signals across outcomes
      const dominantOutcome = Number.isFinite(nowMs)
        ? getDominantOutcome(trade.market_id, nowMs)
        : null;
      const shouldCheckOutcome = dominantOutcome
        ? trade.outcome === dominantOutcome
        : trade.outcome === "Yes";
      if (shouldCheckOutcome) {
        const gateKey = `${trade.market_id}:${dominantOutcome ?? "Yes"}`;
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

      const tx = String((trade as any)?.raw?.payload?.transactionHash ?? "");
      const part = LOG_TRADE_DEBUG
        ? `${trade.outcome} ${trade.side} px=${trade.price} sz=${trade.size} tx=${tx}`
        : `${trade.outcome} ${trade.side} px=${trade.price} sz=${trade.size}`;
      if (LOG_TRADE_GROUPED && tx) {
        logGroupedTrade(tx, part);
      } else {
        console.log(`[trade] ${part}`);
      }
    } catch (e: any) {
      const m = e?.message ?? "";
      if (m.includes("duplicate key value violates unique constraint")) return;
      if (m === "spooled") return;
      console.error("[trade] insert failed:", m);
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/a2ce0bcd-2fd9-4a62-b9b6-9bec63aa6bf3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          location: 'services/ingestion/src/index.ts:onMessage:error',
          message: 'trade processing threw error',
          runId: 'pre-fix',
          hypothesisId: 'H8',
          data: {
            tradeId: trade?.id ?? null,
            errorMessage: m,
          },
        }),
      }).catch(() => {});
      // #endregion agent log
    }
  },
});

async function backfillByConditionId(
  slug: string,
  conditionId: string,
  sinceMs: number
): Promise<number> {
  const url = new URL(BACKFILL_URL);
  url.searchParams.set("market", conditionId);
  url.searchParams.set("since", String(Math.floor(sinceMs / 1000)));

  const res = await withRetry(
    () => fetch(url.toString(), { headers: { accept: "application/json" } }),
    "backfillFetch"
  );
  if (!res.ok) return 0;
  const data: any = await res.json();
  const list =
    (Array.isArray(data) && data) || data?.trades || data?.data || data?.result || [];
  if (!Array.isArray(list) || list.length === 0) return 0;

  console.log(`[backfill] ${slug} fetched ${list.length} candidates (conditionId ${conditionId.slice(0, 12)})`);
  let kept = 0;
  for (const t of list) {
    if (Number.isFinite(MAX_BACKFILL_TRADES_PER_SLUG) && MAX_BACKFILL_TRADES_PER_SLUG > 0 && kept >= MAX_BACKFILL_TRADES_PER_SLUG) break;
    const trade = toTradeInsertFromObj(t);
    if (!trade) continue;
    const tradeTsMs = Date.parse(trade.timestamp);
    if (Number.isFinite(tradeTsMs) && isDuplicateTrade(trade.id, tradeTsMs)) continue;
    try {
      await insertTrade(trade);
      await updateAggregateBuffered(trade);
      kept += 1;
      lastTradeBySlug.set(slug, Date.parse(trade.timestamp));
    } catch (e: any) {
      if (e?.message?.includes("duplicate key value violates unique constraint")) continue;
    }
  }
  return kept;
}

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

      // Collect conditionIds: single-market or multi-market event children
      const singleId = trackedMarketIdBySlug.get(slug);
      const multiIds = allMarketIdsBySlug.get(slug);
      const conditionIds = singleId
        ? [singleId]
        : multiIds && multiIds.length > 0
          ? multiIds
          : [];

      if (conditionIds.length > 0) {
        let totalKept = 0;
        for (const cid of conditionIds) {
          const kept = await backfillByConditionId(slug, cid, sinceMs);
          totalKept += kept;
        }
        if (totalKept > 0) {
          console.log(`[backfill] ${slug} ingested ${totalKept} trade(s) total`);
        }
      } else {
        // Fallback: eventSlug param (unreliable but last resort)
        const url = new URL(BACKFILL_URL);
        url.searchParams.set("eventSlug", slug);
        url.searchParams.set("since", String(Math.floor(sinceMs / 1000)));

        const res = await withRetry(
          () => fetch(url.toString(), { headers: { accept: "application/json" } }),
          "backfillFetch"
        );
        if (!res.ok) continue;
        const data: any = await res.json();
        const list =
          (Array.isArray(data) && data) || data?.trades || data?.data || data?.result || [];
        if (!Array.isArray(list)) continue;

        let kept = 0;
        if (list.length > 0) {
          console.log(`[backfill] ${slug} fetched ${list.length} candidates (via eventSlug)`);
        }
        for (const t of list) {
          const tSlug = String(t?.eventSlug ?? t?.slug ?? "");
          if (tSlug && tSlug !== slug) continue;
          if (Number.isFinite(MAX_BACKFILL_TRADES_PER_SLUG) && MAX_BACKFILL_TRADES_PER_SLUG > 0 && kept >= MAX_BACKFILL_TRADES_PER_SLUG) break;
          const trade = toTradeInsertFromObj(t);
          if (!trade) continue;
          const tradeTsMs = Date.parse(trade.timestamp);
          if (Number.isFinite(tradeTsMs) && isDuplicateTrade(trade.id, tradeTsMs)) continue;
          try {
            await insertTrade(trade);
            await updateAggregateBuffered(trade);
            kept += 1;
            lastTradeBySlug.set(slug, Date.parse(trade.timestamp));
          } catch (e: any) {
            if (e?.message?.includes("duplicate key value violates unique constraint")) continue;
          }
        }
        if (kept > 0) {
          console.log(`[backfill] ${slug} ingested ${kept} trade(s)`);
        }
      }
    }
  } finally {
    backfillRunning = false;
  }
}

if (BACKFILL_URL) {
  setInterval(() => {
    runBackfillOnce().catch((e) =>
      console.error("[backfill] error", e?.message ?? e)
    );
  }, BACKFILL_INTERVAL_MS);
  runBackfillOnce().catch((e) => console.error("[backfill] error", e?.message ?? e));
}

setInterval(() => {
  replaySpoolOnce().catch((e) => console.error("[spool] replay error", e?.message ?? e));
}, SPOOL_REPLAY_MS);

// ── Dynamic slug sync from tracked_slugs table ──────────────────────
const SLUG_SYNC_MS = Number(process.env.SLUG_SYNC_MS ?? 30_000);

async function getMarketMetaForSlug(slug: string): Promise<MarketMeta | null> {
  const now = Date.now();
  const cached = marketMetaCache.get(slug);
  if (cached && now - cached.ts < MARKET_META_TTL_MS) return cached.meta;
  const rawMeta = await fetchMarketMeta({ eventSlug: slug });
  const meta = rawMeta ? { ...rawMeta, slug: rawMeta.slug ?? slug } : null;
  if (meta) {
    marketMetaCache.set(slug, { ts: now, meta });
    const ms = meta.resolvedAtMs ?? meta.endTimeMs;
    if (meta.marketId && ms != null) {
      const prev = marketResolutionById.get(meta.marketId);
      if (!prev || ms < prev.ms) {
        marketResolutionById.set(meta.marketId, { ms, source: "metadata" });
      }
    }
    persistMarketResolution(meta, "metadata");
  }
  return meta;
}

function removeTrackedSlug(slug: string) {
  if (!eventSlugSet.has(slug)) return;
  eventSlugSet.delete(slug);
  eventSlugs = eventSlugs.filter((s) => s !== slug);
  lastTradeBySlug.delete(slug);
  const marketId = trackedMarketIdBySlug.get(slug);
  if (marketId) {
    trackedMarketIdBySlug.delete(slug);
    let stillUsed = false;
    for (const id of trackedMarketIdBySlug.values()) {
      if (id === marketId) {
        stillUsed = true;
        break;
      }
    }
    if (!stillUsed) trackedMarketIds.delete(marketId);
  }
  // Clean up multi-market event children
  const childIds = allMarketIdsBySlug.get(slug);
  if (childIds) {
    for (const cid of childIds) {
      trackedMarketIds.delete(cid);
      childMarketSlugById.delete(cid);
      childMarketEventSlugById.delete(cid);
    }
    allMarketIdsBySlug.delete(slug);
  }
}

function cleanupResolvedMarket(meta: MarketMeta | null) {
  const marketId = meta?.marketId;
  if (!marketId) return;
  const normalizedId = marketId.toLowerCase();
  const assets = marketAssets.get(marketId);
  if (assets) {
    for (const assetId of assets) {
      trackedAssets.delete(assetId);
      assetMeta.delete(assetId);
      lastClobTickMs.delete(assetId);
    }
    marketAssets.delete(marketId);
  }
  marketPrimaryAsset.delete(marketId);
  hydratedMarkets.delete(marketId);
  childMarketSlugById.delete(normalizedId);
  childMarketEventSlugById.delete(normalizedId);
  let stillUsed = false;
  for (const id of trackedMarketIdBySlug.values()) {
    if (id === normalizedId) {
      stillUsed = true;
      break;
    }
  }
  if (!stillUsed) {
    // Also check multi-market event children
    for (const ids of allMarketIdsBySlug.values()) {
      if (ids.includes(normalizedId)) {
        stillUsed = true;
        break;
      }
    }
  }
  if (!stillUsed) trackedMarketIds.delete(normalizedId);
  scheduleClobReconnect();
}

function resolveEventSlugForMarket(marketId: string, slugCandidates: Set<string>) {
  const normalizedId = marketId.toLowerCase();
  const direct = childMarketEventSlugById.get(normalizedId);
  if (direct) return direct;

  for (const s of slugCandidates) {
    const ids = allMarketIdsBySlug.get(s);
    if (ids && ids.includes(normalizedId)) return s;
  }

  for (const [slug, ids] of allMarketIdsBySlug.entries()) {
    if (ids.includes(normalizedId)) return slug;
  }

  return null;
}

let syncSupabaseWarned = false;
async function syncTrackedSlugs() {
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!sbUrl || !sbKey) {
      if (TRACK_SINGLE_SLUG && !syncSupabaseWarned) {
        syncSupabaseWarned = true;
        console.warn(
          "[slug-sync] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in single-slug mode; tracked slug will not update from frontend."
        );
      }
      return;
    }
    const baseQuery = TRACK_SINGLE_SLUG
      ? "tracked_slugs?select=slug,created_at&active=eq.true&order=created_at.desc&limit=1"
      : "tracked_slugs?select=slug&active=eq.true";
    const res = await fetch(
      `${sbUrl}/rest/v1/${baseQuery}`,
      {
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
        },
      }
    );
    if (!res.ok) return;
    const rows = (await res.json()) as { slug: string; created_at?: string }[];
    const desiredSlugs = new Set(rows.map((r) => r.slug.trim()).filter(Boolean));
    if (TRACK_SINGLE_SLUG && desiredSlugs.size > 0) {
      console.log("[slug-sync] tracking from DB:", Array.from(desiredSlugs).join(", "));
      for (const existing of Array.from(eventSlugSet)) {
        if (!desiredSlugs.has(existing)) {
          const marketId = trackedMarketIdBySlug.get(existing);
          removeTrackedSlug(existing);
          if (marketId) cleanupResolvedMarket({ marketId, slug: existing } as MarketMeta);
        }
      }
    }
    let added = 0;
    let skipped = 0;
    for (const row of rows) {
      const s = row.slug.trim();
      if (!s) continue;
      if (resolvedSlugs.has(s)) {
        skipped += 1;
        continue;
      }
      const meta = await getMarketMetaForSlug(s);
      if (meta?.marketId) {
        const normalizedId = meta.marketId.toLowerCase();
        trackedMarketIdBySlug.set(s, normalizedId);
        trackedMarketIds.add(normalizedId);
        console.log("[slug-sync] tracked marketId:", normalizedId.slice(0, 16) + "…");
      } else if (!allMarketIdsBySlug.has(s)) {
        // Single-market meta returned null → try events API for multi-market event slug
        const childMetas = await fetchEventChildMarkets(s);
        if (childMetas && childMetas.length > 0) {
          const childIds: string[] = [];
          for (const child of childMetas) {
            if (!child.marketId) continue;
            const nid = child.marketId.toLowerCase();
            childIds.push(nid);
            trackedMarketIds.add(nid);
            // Store child's own slug for hydration metadata lookups
            if (child.slug) childMarketSlugById.set(nid, child.slug);
            childMarketEventSlugById.set(nid, s);
          }
          if (childIds.length > 0) {
            allMarketIdsBySlug.set(s, childIds);
            console.log(`[slug-sync] multi-market event: ${s} → ${childIds.length} child markets`);
          }
        }
      }
      const resolvedByMarket =
        meta?.marketId && marketResolutionById.has(meta.marketId)
          ? marketResolutionById.get(meta.marketId)?.ms ?? null
          : null;
      const resolved =
        meta && (isMetaResolved(meta, Date.now()) ||
        (resolvedByMarket != null && resolvedByMarket <= Date.now() + RESOLUTION_SKEW_MS));

      if (resolved) {
        const ts =
          meta?.resolvedAtMs ??
          meta?.endTimeMs ??
          resolvedByMarket ??
          Date.now();
        resolvedSlugs.set(s, ts);
        removeTrackedSlug(s);
        cleanupResolvedMarket(meta ?? null);
        console.log(
          `[slug-sync] skipping resolved slug=${s} resolved_at=${new Date(ts).toISOString()}`
        );
        skipped += 1;
        continue;
      }

      if (!eventSlugSet.has(s)) {
        eventSlugSet.add(s);
        eventSlugs.push(s);
        added++;
        console.log("[slug-sync] new slug:", s);
        // Proactively hydrate so CLOB gets subscribed even if no trades arrive yet
        if (meta?.marketId) {
          void hydrateMarket(meta.marketId, s);
        }
        // Multi-market: hydrate all child markets
        const childIds = allMarketIdsBySlug.get(s);
        if (childIds) {
          for (const cid of childIds) {
            void hydrateMarket(cid, s);
          }
        }
      }
    }
    if (added > 0) {
      console.log(
        `[slug-sync] added ${added} slug(s), total: ${eventSlugSet.size}`
      );
    }
    if (skipped > 0) {
      console.log(`[slug-sync] skipped ${skipped} resolved slug(s)`);
    }

    if (TRACK_SINGLE_SLUG && desiredSlugs.size > 0) {
      const allowedMarketIds = new Set<string>();
      for (const slug of desiredSlugs) {
        const id = trackedMarketIdBySlug.get(slug);
        if (id) allowedMarketIds.add(id);
        // Also include multi-market event child IDs
        const childIds = allMarketIdsBySlug.get(slug);
        if (childIds) {
          for (const cid of childIds) allowedMarketIds.add(cid);
        }
      }
      for (const marketId of Array.from(marketAssets.keys())) {
        if (!allowedMarketIds.has(marketId)) {
          cleanupResolvedMarket({ marketId } as MarketMeta);
        }
      }
    }

    // Immediate backfill after adding new slugs to cover the startup gap
    if (added > 0 && BACKFILL_URL) {
      console.log(`[slug-sync] triggering immediate backfill for ${added} new slug(s)`);
      void runBackfillOnce().catch((e) =>
        console.error("[backfill] post-sync error", e?.message ?? e)
      );
    }
  } catch (err: any) {
    console.error("[slug-sync] error:", err?.message ?? err);
  }
}

syncTrackedSlugs().catch(() => {});
setInterval(() => {
  syncTrackedSlugs().catch(() => {});
}, SLUG_SYNC_MS);

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
  console.log("[clob-rebuild] trackedAssets=", trackedAssets.size, "assets:", Array.from(trackedAssets).map(a => `${a.slice(0, 8)}…`));
  const size = Number.isFinite(MAX_CLOB_ASSETS) && MAX_CLOB_ASSETS > 0 ? MAX_CLOB_ASSETS : 100;
  const chunks = chunkAssets(Array.from(trackedAssets), size);
  for (const assetIds of chunks) {
    const handle = connectClobMarketWS({
      assetIds,
      onTick: onClobTick,
    });
    clobWss.push(handle);
  }
}

function scheduleClobReconnect() {
  if (clobReconnectTimer) return;
  clobReconnectTimer = setTimeout(() => {
    clobReconnectTimer = null;
    rebuildClobConnections();
  }, 5000);
}

function expandClobMessages(msg: any): any[] {
  if (!msg) return [];
  const candidate = msg?.data ?? msg?.payload ?? msg?.result ?? msg;
  if (Array.isArray(candidate)) return candidate;

  const changes = candidate?.price_changes ?? msg?.price_changes;
  if (Array.isArray(changes)) {
    const market =
      candidate?.market ??
      candidate?.market_id ??
      candidate?.marketId ??
      msg?.market ??
      msg?.market_id ??
      msg?.marketId ??
      null;
    const timestamp =
      candidate?.timestamp ?? candidate?.ts ?? msg?.timestamp ?? msg?.ts ?? null;
    const base = {
      market,
      market_id: market,
      timestamp,
      best_bid: candidate?.best_bid ?? msg?.best_bid,
      best_ask: candidate?.best_ask ?? msg?.best_ask,
      bids: candidate?.bids ?? msg?.bids,
      asks: candidate?.asks ?? msg?.asks,
      orderbook: candidate?.orderbook ?? msg?.orderbook,
    };
    return changes.map((change) => ({ ...base, ...change }));
  }

  if (candidate && typeof candidate === "object" && candidate !== msg) {
    const market =
      (candidate as any)?.market ??
      (candidate as any)?.market_id ??
      (candidate as any)?.marketId ??
      msg?.market ??
      msg?.market_id ??
      msg?.marketId ??
      null;
    const timestamp =
      (candidate as any)?.timestamp ??
      (candidate as any)?.ts ??
      msg?.timestamp ??
      msg?.ts ??
      null;
    const enriched: any = { ...candidate };
    if (market != null && enriched.market == null && enriched.market_id == null && enriched.marketId == null) {
      enriched.market = market;
      enriched.market_id = market;
    }
    if (timestamp != null && enriched.timestamp == null) {
      enriched.timestamp = timestamp;
    }
    return [enriched];
  }

  return [candidate];
}

async function onClobTick(msg: any) {
    noteResolutionFromMessage(msg, "clob");
    if (LOG_CLOB_RAW) {
      console.log("[clob raw]", JSON.stringify(msg).slice(0, 300));
    }

    const items = expandClobMessages(msg);
    if (items.length === 0) return;

    for (const item of items) {
      const t = toSyntheticMid(item);
      if (!t) {
        const assetId = String(item?.asset_id ?? item?.assetId ?? item?.asset ?? "");
        logMidDebug(`mid:null:${assetId}`, "[clob] toSyntheticMid returned null", {
          keys: Object.keys(item ?? {}),
          hasBids: Array.isArray(item?.bids) || Array.isArray(item?.orderbook?.bids),
          hasAsks: Array.isArray(item?.asks) || Array.isArray(item?.orderbook?.asks),
          hasPriceChanges: Array.isArray(item?.price_changes),
        });
        continue;
      }

      const meta = assetMeta.get(t.assetId);
      const marketId = t.marketId || meta?.marketId;
      const outcome = meta?.outcome ?? null;
      if (!marketId) continue;

      // Feed realtime detector for exactly one asset per market to avoid double-counting.
      // For Yes/No markets the primary is "Yes"; for Up/Down it's the first token.
      const isPrimary = marketPrimaryAsset.get(marketId) === t.assetId;
      if (isPrimary && t.mid != null && Number.isFinite(t.mid)) {
        void movementRealtime.onPriceUpdate({
          market_id: marketId,
          asset_id: t.assetId,
          outcome,
          price: t.mid,
          spreadPct: t.spreadPct,
          bestBidSize: t.bestBidSize ?? null,
          bestAskSize: t.bestAskSize ?? null,
          tsMs: t.tsMs,
          source: "mid",
        }).catch((err: any) => console.warn("[movement-rt] error:", err?.message ?? err));
      }

      try {
        if (t.mid == null || !Number.isFinite(t.mid)) continue;
        lastClobTickMs.set(t.assetId, t.tsMs);
        if (!shouldStoreMid(t.assetId, t.bestBid, t.bestAsk, t.mid, t.tsMs)) continue;
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
          const tsIso = new Date(t.tsMs).toISOString();
          console.log(
            `[mid] market=${marketId} outcome=${outcome ?? "n/a"} asset=${t.assetId} ts=${tsIso} ` +
              `bid=${t.bestBid?.toFixed(4) ?? "n/a"} ask=${t.bestAsk?.toFixed(4) ?? "n/a"} ` +
              `mid=${(t.mid ?? 0).toFixed(4)} spread%=${t.spreadPct?.toFixed(4) ?? "n/a"}`
          );
        }
      } catch (e: any) {
        console.error("[mid] insert failed:", e?.message ?? e);
      }
    }
}

// start initial CLOB connection with any known assets (likely none)
scheduleClobReconnect();

import { fetchTrades, fetchOrderbook } from "./jupiter.api";
import type { JupiterRawTrade, JupiterOrderbook } from "./jupiter.types";

type PollerOpts = {
  /** Called for each new trade */
  onTrade: (trade: JupiterRawTrade) => Promise<void> | void;
  /** Called with a fresh orderbook snapshot */
  onOrderbook: (
    marketId: string,
    book: JupiterOrderbook
  ) => Promise<void> | void;
  /** Trade poll interval in ms (default 5000) */
  tradePollMs?: number;
  /**
   * Minimum gap between ANY two API requests in ms (default 1500).
   * Free tier = 1 RPS, so 1500ms gives safe headroom.
   */
  minRequestGapMs?: number;
};

export type JupiterPollerHandle = {
  startTradePoller: () => void;
  addOrderbookMarket: (marketId: string) => void;
  removeOrderbookMarket: (marketId: string) => void;
  orderbookMarkets: () => string[];
  close: () => void;
};

/**
 * REST poller with built-in rate limiting and exponential backoff.
 *
 * Uses a single sequential queue for all API calls so we never exceed
 * the free-tier 1 RPS limit regardless of how many markets are tracked.
 *
 * Orderbook markets are polled round-robin: one market per tick,
 * interleaved with trade polls.
 *
 * On consecutive failures, backs off exponentially (up to 60s) and
 * suppresses repeated error logs to reduce noise.
 */
export function createJupiterPoller(opts: PollerOpts): JupiterPollerHandle {
  const tradePollMs = opts.tradePollMs ?? 5_000;
  const minGapMs = opts.minRequestGapMs ?? 1_500;

  let destroyed = false;
  let tradeTimer: NodeJS.Timeout | null = null;
  let orderbookTimer: NodeJS.Timeout | null = null;

  // Track highest trade ID to avoid re-processing
  let lastSeenTradeId = 0;

  // Round-robin orderbook state
  const orderbookSet = new Set<string>();
  let orderbookQueue: string[] = [];
  let orderbookIdx = 0;

  // ── Backoff state ───────────────────────────────────────────────
  let tradeConsecFails = 0;
  let tradeBackoffMs = 0;
  let tradeLastLoggedFail = 0;

  const obConsecFails = new Map<string, number>();
  let obLastLoggedFail = 0;

  const BASE_BACKOFF_MS = 3_000;
  const MAX_BACKOFF_MS = 60_000;
  const LOG_THROTTLE_MS = 30_000; // only log errors every 30s

  function calcBackoff(fails: number): number {
    if (fails <= 1) return 0;
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, fails - 2), MAX_BACKOFF_MS);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Trade Poller ────────────────────────────────────────────────
  async function pollTrades() {
    if (destroyed) return;

    // Apply backoff if we've had consecutive failures
    if (tradeBackoffMs > 0) {
      await sleep(tradeBackoffMs);
      if (destroyed) return;
    }

    try {
      const trades = await fetchTrades();
      if (!trades.length) {
        // Empty response is OK, reset failures
        tradeConsecFails = 0;
        tradeBackoffMs = 0;
        return;
      }

      // Success — reset backoff
      tradeConsecFails = 0;
      tradeBackoffMs = 0;

      trades.sort((a, b) => a.id - b.id);

      let newCount = 0;
      for (const t of trades) {
        if (t.id <= lastSeenTradeId) continue;
        lastSeenTradeId = t.id;
        newCount++;
        try {
          await opts.onTrade(t);
        } catch (err: any) {
          console.error("[jup-poller] onTrade error:", err?.message);
        }
      }

      if (newCount > 0) {
        console.log(
          `[jup-poller] ${newCount} new trade(s), cursor=${lastSeenTradeId}`
        );
      }
    } catch (err: any) {
      tradeConsecFails++;
      tradeBackoffMs = calcBackoff(tradeConsecFails);

      const now = Date.now();
      if (now - tradeLastLoggedFail > LOG_THROTTLE_MS) {
        tradeLastLoggedFail = now;
        const backoffSec = (tradeBackoffMs / 1000).toFixed(0);
        console.warn(
          `[jup-poller] trade poll failed (${tradeConsecFails}x, backoff ${backoffSec}s): ${err?.message}`
        );
      }
    }
  }

  // ── Orderbook Round-Robin ───────────────────────────────────────
  // Polls ONE market per tick, cycling through all tracked markets.
  // Gap between ticks = minGapMs, so with 10 markets each gets
  // polled every ~15s (10 * 1.5s).
  async function pollNextOrderbook() {
    if (destroyed || orderbookQueue.length === 0) return;

    // Wrap index
    if (orderbookIdx >= orderbookQueue.length) orderbookIdx = 0;
    const marketId = orderbookQueue[orderbookIdx];
    orderbookIdx++;

    // Check per-market backoff
    const fails = obConsecFails.get(marketId) ?? 0;
    const backoff = calcBackoff(fails);
    if (backoff > 0) {
      await sleep(backoff);
      if (destroyed) return;
    }

    try {
      const book = await fetchOrderbook(marketId);
      // Success — reset this market's failure count
      obConsecFails.set(marketId, 0);
      await opts.onOrderbook(marketId, book);
    } catch (err: any) {
      const newFails = (obConsecFails.get(marketId) ?? 0) + 1;
      obConsecFails.set(marketId, newFails);

      const now = Date.now();
      if (now - obLastLoggedFail > LOG_THROTTLE_MS) {
        obLastLoggedFail = now;
        const backoffSec = (calcBackoff(newFails) / 1000).toFixed(0);
        console.warn(
          `[jup-poller] orderbook(${marketId.slice(0, 16)}...) failed (${newFails}x, backoff ${backoffSec}s): ${err?.message}`
        );
      }
    }
  }

  function rebuildQueue() {
    orderbookQueue = Array.from(orderbookSet);
    orderbookIdx = 0;
  }

  function startOrderbookLoop() {
    if (orderbookTimer || destroyed) return;
    orderbookTimer = setInterval(
      () => void pollNextOrderbook(),
      minGapMs
    );
  }

  return {
    startTradePoller() {
      if (tradeTimer || destroyed) return;
      console.log(`[jup-poller] trade polling every ${tradePollMs}ms`);
      void pollTrades();
      tradeTimer = setInterval(() => void pollTrades(), tradePollMs);
    },

    addOrderbookMarket(marketId: string) {
      if (destroyed || orderbookSet.has(marketId)) return;
      orderbookSet.add(marketId);
      rebuildQueue();
      startOrderbookLoop();
      const cycleSec = (orderbookQueue.length * minGapMs / 1000).toFixed(1);
      console.log(
        `[jup-poller] +orderbook ${marketId.slice(0, 20)}... (${orderbookQueue.length} markets, full cycle ~${cycleSec}s)`
      );
    },

    removeOrderbookMarket(marketId: string) {
      if (!orderbookSet.has(marketId)) return;
      orderbookSet.delete(marketId);
      obConsecFails.delete(marketId);
      rebuildQueue();
      console.log(
        `[jup-poller] -orderbook ${marketId.slice(0, 20)}... (${orderbookQueue.length} remaining)`
      );
    },

    orderbookMarkets() {
      return Array.from(orderbookSet);
    },

    close() {
      destroyed = true;
      if (tradeTimer) {
        clearInterval(tradeTimer);
        tradeTimer = null;
      }
      if (orderbookTimer) {
        clearInterval(orderbookTimer);
        orderbookTimer = null;
      }
      orderbookSet.clear();
      orderbookQueue = [];
      obConsecFails.clear();
      console.log("[jup-poller] stopped all polling");
    },
  };
}

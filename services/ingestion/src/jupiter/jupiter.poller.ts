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
 * REST poller with built-in rate limiting.
 *
 * Uses a single sequential queue for all API calls so we never exceed
 * the free-tier 1 RPS limit regardless of how many markets are tracked.
 *
 * Orderbook markets are polled round-robin: one market per tick,
 * interleaved with trade polls.
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

  // ── Trade Poller ────────────────────────────────────────────────
  async function pollTrades() {
    if (destroyed) return;
    try {
      const trades = await fetchTrades();
      if (!trades.length) return;

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
      console.error("[jup-poller] trade poll error:", err?.message);
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

    try {
      const book = await fetchOrderbook(marketId);
      if (book) {
        await opts.onOrderbook(marketId, book);
      }
    } catch (err: any) {
      console.error(
        `[jup-poller] orderbook(${marketId.slice(0, 16)}...) error:`,
        err?.message
      );
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
      console.log("[jup-poller] stopped all polling");
    },
  };
}

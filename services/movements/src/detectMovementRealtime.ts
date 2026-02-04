import { supabase } from "../../storage/src/db";

type PriceUpdate = {
  market_id: string;
  asset_id: string;
  outcome?: string | null;
  price: number;
  spreadPct?: number | null;
  bestBidSize?: number | null;
  bestAskSize?: number | null;
  tsMs: number;
  source: "mid" | "trade";
};

type Bucket = {
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type State = {
  lastPrice: number;
  lastTs: number;
  emaFast: number;
  emaSlow: number;
  lastBucketId: number;
  buckets: Array<Bucket | null>;
  lastEventTs: Map<string, number>;
  emaDir: -1 | 1;
  emaPendingDir: -1 | 1 | 0;
  emaPendingCount: number;
  emaLastUpTs: number;
  emaLastDownTs: number;
  pendingPrice: number;
  pendingStartTs: number;
  pendingCount: number;
};

const BUCKET_MS = 60_000;
const BUCKETS = 60;
const BREAKOUT_PCT = 0.03;
const EMA_FAST_MS = 60_000;
const EMA_SLOW_MS = 300_000;
const MIN_UPDATE_MS = Number(process.env.MOVEMENT_RT_MIN_MS ?? 2000);
const MIN_STEP = Number(process.env.MOVEMENT_RT_MIN_STEP ?? 0.01);
const EVENT_COOLDOWN_MS = Number(process.env.MOVEMENT_RT_EVENT_COOLDOWN_MS ?? 60_000);
const EVICT_IDLE_MS = Number(process.env.MOVEMENT_RT_EVICT_MS ?? 30 * 60_000);
const MAX_SPREAD_PCT = Number(process.env.MOVEMENT_RT_MAX_SPREAD_PCT ?? 0.1);
const EMA_MIN_PCT = Number(process.env.MOVEMENT_RT_EMA_MIN_PCT ?? 0.003);
const EMA_GAP_PCT = Number(process.env.MOVEMENT_RT_EMA_GAP_PCT ?? 0.005);
const EMA_CONFIRM_TICKS = Number(process.env.MOVEMENT_RT_EMA_CONFIRM_TICKS ?? 3);
const EMA_DIR_COOLDOWN_MS = Number(process.env.MOVEMENT_RT_EMA_DIR_COOLDOWN_MS ?? 90_000);
const MIN_TOP_SIZE = Number(process.env.MOVEMENT_RT_MIN_TOP_SIZE ?? 5);
const PERSIST_TICKS = Number(process.env.MOVEMENT_RT_PERSIST_TICKS ?? 3);
const PERSIST_MS = Number(process.env.MOVEMENT_RT_PERSIST_MS ?? 5000);
const TRADE_CONFIRM_MS = Number(process.env.MOVEMENT_RT_TRADE_CONFIRM_MS ?? 60_000);

function emaUpdate(prev: number, price: number, dtMs: number, tauMs: number) {
  const alpha = 1 - Math.exp(-dtMs / tauMs);
  return prev + alpha * (price - prev);
}

function clampPct(n: number | null) {
  return n == null ? null : Math.max(-1, Math.min(1, n));
}

function nowIso(ms: number) {
  return new Date(ms).toISOString();
}

export class MovementRealtime {
  private states = new Map<string, State>();
  private lastTradeByAsset = new Map<string, number>();

  onTrade = (marketId: string, assetId: string, tsMs: number) => {
    if (!marketId || !assetId || !Number.isFinite(tsMs)) return;
    this.lastTradeByAsset.set(`${marketId}:${assetId}`, tsMs);
  };

  onPriceUpdate = async (u: PriceUpdate) => {
    if (!Number.isFinite(u.price) || !Number.isFinite(u.tsMs)) return;
    const key = `${u.market_id}:${u.asset_id}`;
    const state = this.states.get(key) ?? this.initState(u);

    if (this.shouldSkipUpdate(state, u)) return;

    const dtMs = Math.max(1, u.tsMs - state.lastTs);
    state.emaFast = emaUpdate(state.emaFast, u.price, dtMs, EMA_FAST_MS);
    state.emaSlow = emaUpdate(state.emaSlow, u.price, dtMs, EMA_SLOW_MS);

    this.updateBuckets(state, u.tsMs, u.price);
    state.lastPrice = u.price;
    state.lastTs = u.tsMs;

    const stable = this.updateStability(state, u);
    if (stable) {
      try {
        await this.checkBreakout(u, state);
        await this.checkEmaCross(u, state);
      } catch (err) {
        console.error("[movement-rt] insert failed", err);
      }
    }

    this.evictIdle();
  };

  private initState(u: PriceUpdate): State {
    const state: State = {
      lastPrice: u.price,
      lastTs: u.tsMs,
      emaFast: u.price,
      emaSlow: u.price,
      lastBucketId: Math.floor(u.tsMs / BUCKET_MS),
      buckets: new Array<Bucket | null>(BUCKETS).fill(null),
      lastEventTs: new Map<string, number>(),
      emaDir: 1,
      emaPendingDir: 0,
      emaPendingCount: 0,
      emaLastUpTs: 0,
      emaLastDownTs: 0,
      pendingPrice: u.price,
      pendingStartTs: u.tsMs,
      pendingCount: 1,
    };
    this.updateBuckets(state, u.tsMs, u.price);
    this.states.set(`${u.market_id}:${u.asset_id}`, state);
    return state;
  }

  private shouldSkipUpdate(state: State, u: PriceUpdate) {
    if (
      u.spreadPct != null &&
      Number.isFinite(u.spreadPct) &&
      u.spreadPct > MAX_SPREAD_PCT
    ) {
      return true;
    }
    const bidSizeOk = u.bestBidSize != null && Number.isFinite(u.bestBidSize);
    const askSizeOk = u.bestAskSize != null && Number.isFinite(u.bestAskSize);
    if (MIN_TOP_SIZE > 0 && (bidSizeOk || askSizeOk)) {
      const bidSize = bidSizeOk ? (u.bestBidSize as number) : Infinity;
      const askSize = askSizeOk ? (u.bestAskSize as number) : Infinity;
      if (bidSize < MIN_TOP_SIZE && askSize < MIN_TOP_SIZE) return true;
    }
    if (u.tsMs - state.lastTs < MIN_UPDATE_MS) return true;
    if (Math.abs(u.price - state.lastPrice) < MIN_STEP) return true;
    return false;
  }

  private updateStability(state: State, u: PriceUpdate) {
    if (Math.abs(u.price - state.pendingPrice) < MIN_STEP) {
      state.pendingCount += 1;
    } else {
      state.pendingPrice = u.price;
      state.pendingStartTs = u.tsMs;
      state.pendingCount = 1;
    }
    if (PERSIST_TICKS > 0 && state.pendingCount >= PERSIST_TICKS) return true;
    if (PERSIST_MS > 0 && u.tsMs - state.pendingStartTs >= PERSIST_MS) return true;
    return false;
  }

  private updateBuckets(state: State, tsMs: number, price: number) {
    const bucketId = Math.floor(tsMs / BUCKET_MS);
    if (bucketId !== state.lastBucketId) {
      state.lastBucketId = bucketId;
    }
    const idx = bucketId % BUCKETS;
    const startMs = bucketId * BUCKET_MS;
    const existing = state.buckets[idx];

    if (!existing || existing.startMs !== startMs) {
      state.buckets[idx] = {
        startMs,
        open: price,
        high: price,
        low: price,
        close: price,
      };
      return;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
  }

  private async checkBreakout(u: PriceUpdate, state: State) {
    const nowMs = u.tsMs;
    const windowStartMs = nowMs - BUCKET_MS * BUCKETS;

    let min: number | null = null;
    let max: number | null = null;

    for (const b of state.buckets) {
      if (!b || b.startMs < windowStartMs) continue;
      min = min == null ? b.low : Math.min(min, b.low);
      max = max == null ? b.high : Math.max(max, b.high);
    }

    if (min == null || max == null || min <= 0) return;

    const up = u.price >= max * (1 + BREAKOUT_PCT);
    const down = u.price <= min * (1 - BREAKOUT_PCT);

    if (up) {
      await this.emitEvent(u, "REALTIME_BREAKOUT_UP", min, u.price, windowStartMs, nowMs);
    } else if (down) {
      await this.emitEvent(u, "REALTIME_BREAKOUT_DOWN", max, u.price, windowStartMs, nowMs);
    }
  }

  private async checkEmaCross(u: PriceUpdate, state: State) {
    const slow = state.emaSlow;
    if (slow > 0 && Math.abs(u.price - slow) / slow < EMA_MIN_PCT) return;

    const diff = state.emaFast - state.emaSlow;
    const gapPct = Math.abs(diff) / (u.price || 1);
    if (gapPct < EMA_GAP_PCT) return;

    const dir: -1 | 1 = diff >= 0 ? 1 : -1;

    if (dir === state.emaDir) {
      state.emaPendingDir = 0;
      state.emaPendingCount = 0;
      return;
    }

    if (state.emaPendingDir !== dir) {
      state.emaPendingDir = dir;
      state.emaPendingCount = 1;
      return;
    }

    state.emaPendingCount += 1;
    if (state.emaPendingCount < EMA_CONFIRM_TICKS) return;

    if (dir === 1 && u.tsMs - state.emaLastUpTs < EMA_DIR_COOLDOWN_MS) return;
    if (dir === -1 && u.tsMs - state.emaLastDownTs < EMA_DIR_COOLDOWN_MS) return;

    state.emaDir = dir;
    state.emaPendingDir = 0;
    state.emaPendingCount = 0;
    if (dir === 1) state.emaLastUpTs = u.tsMs;
    else state.emaLastDownTs = u.tsMs;

    const reason = dir === 1 ? "REALTIME_EMA_CROSS_UP" : "REALTIME_EMA_CROSS_DOWN";
    await this.emitEvent(u, reason, state.emaSlow, u.price, u.tsMs - EMA_SLOW_MS, u.tsMs);
  }

  private async emitEvent(
    u: PriceUpdate,
    reason: string,
    startPrice: number,
    endPrice: number,
    startMs: number,
    endMs: number
  ) {
    const last = this.getLastEventTs(u, reason);
    if (u.tsMs - last < EVENT_COOLDOWN_MS) return;
    if (!this.hasRecentTrade(u)) return;

    this.setLastEventTs(u, reason, u.tsMs);

    const row = {
      market_id: u.market_id,
      asset_id: u.asset_id,
      outcome: u.outcome ?? null,
      start_time: nowIso(startMs),
      end_time: nowIso(endMs),
      price_start: startPrice,
      price_end: endPrice,
      volume: 0,
      reason,
    };

    const { error } = await supabase.from("movement_events").insert(row);
    if (error) throw error;

    const pct = clampPct((endPrice - startPrice) / (startPrice || 1));
    console.log(
      `[movement-rt] ${reason} market=${u.market_id} price=${endPrice.toFixed(4)} pct=${pct?.toFixed(3) ?? "n/a"}`
    );
  }

  private getLastEventTs(u: PriceUpdate, reason: string) {
    const key = `${u.market_id}:${u.asset_id}:${reason}`;
    return this.states.get(`${u.market_id}:${u.asset_id}`)?.lastEventTs.get(key) ?? 0;
  }

  private setLastEventTs(u: PriceUpdate, reason: string, ts: number) {
    const key = `${u.market_id}:${u.asset_id}`;
    const state = this.states.get(key);
    if (!state) return;
    const k = `${u.market_id}:${u.asset_id}:${reason}`;
    state.lastEventTs.set(k, ts);
  }

  private evictIdle() {
    const now = Date.now();
    for (const [key, s] of this.states.entries()) {
      if (now - s.lastTs > EVICT_IDLE_MS) this.states.delete(key);
    }
  }

  private hasRecentTrade(u: PriceUpdate) {
    if (u.source === "trade") return true;
    if (TRADE_CONFIRM_MS <= 0) return true;
    const lastTrade = this.lastTradeByAsset.get(`${u.market_id}:${u.asset_id}`) ?? 0;
    return u.tsMs - lastTrade <= TRADE_CONFIRM_MS;
  }
}

export const movementRealtime = new MovementRealtime();

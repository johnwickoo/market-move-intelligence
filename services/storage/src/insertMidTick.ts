import { supabase } from "./db";

export type MidTickInsert = {
  market_id: string;
  outcome: string | null;
  asset_id: string;
  ts: string; // ISO
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
  spread: number | null;
  spread_pct: number | null;
  raw: any;
};

type LastTick = {
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
  spread: number | null;
  spread_pct: number | null;
};

const lastTicks = new Map<string, LastTick>();

function sameNum(a: number | null, b: number | null, eps = 1e-9) {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= eps;
}

function isSameTick(a: LastTick, b: LastTick) {
  return (
    sameNum(a.best_bid, b.best_bid) &&
    sameNum(a.best_ask, b.best_ask) &&
    sameNum(a.mid, b.mid) &&
    sameNum(a.spread, b.spread) &&
    sameNum(a.spread_pct, b.spread_pct)
  );
}

const LOG_DEBUG = process.env.LOG_MID_DEBUG === "1";

export async function insertMidTick(row: MidTickInsert) {
  const key = `${row.market_id}:${row.asset_id}:${row.outcome ?? ""}`;
  const current: LastTick = {
    best_bid: row.best_bid,
    best_ask: row.best_ask,
    mid: row.mid,
    spread: row.spread,
    spread_pct: row.spread_pct,
  };
  const prev = lastTicks.get(key);
  if (prev && isSameTick(prev, current)) {
    if (LOG_DEBUG) {
      console.log(`[midtick:dedup] skipped (unchanged) market=${row.market_id.slice(0, 12)} mid=${row.mid} outcome=${row.outcome ?? "n/a"}`);
    }
    return;
  }
  lastTicks.set(key, current);

  if (LOG_DEBUG) {
    console.log(
      `[midtick:insert] market=${row.market_id.slice(0, 12)} outcome=${row.outcome ?? "n/a"} ` +
      `mid=${row.mid} bid=${row.best_bid} ask=${row.best_ask} spread=${row.spread_pct?.toFixed(4) ?? "n/a"} ts=${row.ts}`
    );
  }

  const { error } = await supabase
    .from("market_mid_ticks")
    .insert(row);

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("duplicate key")) {
      if (LOG_DEBUG) console.log(`[midtick:dup-key] market=${row.market_id.slice(0, 12)} ts=${row.ts}`);
      return;
    }
    throw error;
  }

  const { error: upsertErr } = await supabase
    .from("market_mid_latest")
    .upsert(
      {
        market_id: row.market_id,
        asset_id: row.asset_id,
        outcome: row.outcome,
        ts: row.ts,
        best_bid: row.best_bid,
        best_ask: row.best_ask,
        mid: row.mid,
        spread: row.spread,
        spread_pct: row.spread_pct,
      },
      { onConflict: "market_id,asset_id" }
    );

  if (upsertErr) throw upsertErr;

  if (LOG_DEBUG) {
    console.log(`[midtick:ok] stored + upserted latest market=${row.market_id.slice(0, 12)} mid=${row.mid}`);
  }
}

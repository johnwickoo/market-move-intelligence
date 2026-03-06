import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { TradeInsert } from "./types.js";


export const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function dbInsert<T>(
    table: string,
    values: T) {
        const { error } = await supabase.from(table).insert(values);
        if (error) throw error;
    }

export async function insertTrade(trade:TradeInsert)
    {
        const {error} =await supabase
            .from("trades")
            .insert(trade);
        if(error){
            throw error
        }
    }

export async function insertTradeBatch(trades: TradeInsert[]) {
  if (trades.length === 0) return;
  // Use upsert with ignoreDuplicates so one duplicate doesn't fail the whole batch
  const { error } = await supabase
    .from("trades")
    .upsert(trades, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function upsertDominantOutcome(marketId: string, outcome: string, tsIso: string) {
  const { error } = await supabase
    .from("market_dominant_outcomes")
    .upsert(
      {
        market_id: marketId,
        outcome,
        updated_at: tsIso,
      },
      { onConflict: "market_id" }
    );
  if (error) throw error;
}

/**
 * Delete raw trades older than the retention period.
 * Safe to call periodically — deletes in batches to avoid timeouts.
 */
export async function purgeOldTrades(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString();
  let totalDeleted = 0;
  const BATCH = 1000;

  while (true) {
    // Select IDs to delete (batch to avoid long locks)
    const { data, error: selErr } = await supabase
      .from("trades")
      .select("id")
      .lt("timestamp", cutoff)
      .limit(BATCH);
    if (selErr) throw selErr;
    if (!data || data.length === 0) break;

    const ids = data.map((r: any) => r.id);
    const { error: delErr } = await supabase
      .from("trades")
      .delete()
      .in("id", ids);
    if (delErr) throw delErr;

    totalDeleted += ids.length;
    if (data.length < BATCH) break;
  }

  return totalDeleted;
}

export async function upsertMarketResolution(row: {
  market_id: string;
  slug?: string | null;
  title?: string | null;
  end_time?: string | null;
  resolved_at?: string | null;
  resolved?: boolean | null;
  status?: string | null;
  resolved_source?: string | null;
  end_source?: string | null;
  updated_at?: string | null;
}) {
  const payload = {
    ...row,
    updated_at: row.updated_at ?? new Date().toISOString(),
  };
  const { error } = await supabase
    .from("market_resolution")
    .upsert(payload, { onConflict: "market_id" });
  if (error) throw error;
}

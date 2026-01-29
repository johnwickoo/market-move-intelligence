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
  const { error } = await supabase.from("trades").insert(trades);
  if (error) throw error;
}

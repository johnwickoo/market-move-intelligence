import "dotenv/config";
import { connectPolymarketWS } from "./polymarket.ws";
import { updateAggregate } from "../../aggregates/src/updateAggregate";
import { detectMovement } from "../../movements/src/detectMovement";



// Import storage insert function (direct monorepo import for now)
import { insertTrade } from "../../storage/src/db";
import type { TradeInsert } from "../../storage/src/types";

const auth = {
  key: process.env.POLY_API_KEY!,
  secret: process.env.POLY_API_SECRET!,
  passphrase: process.env.POLY_API_PASSPHRASE!,
};

const tokenIds = [
  "114122071509644379678018727908709560226618148003371446110114509806601493071694"
];

function toTradeInsert(msg: any): TradeInsert | null {
  if (msg?.topic !== "activity" || msg?.type !== "trades") return null;
  const p = msg.payload;
  if (!p) return null;

  if (p.price == null || p.size == null || !p.side) return null;

  const marketId = p.conditionId;
  if (!marketId) return null;

  const id = p.transactionHash || `${marketId}:${p.asset}:${msg.timestamp}`;

  // ✅ prefer msg.timestamp (ms), fallback to payload.timestamp (sec)
  const ms =
    typeof msg.timestamp === "number"
      ? msg.timestamp
      : typeof p.timestamp === "number"
        ? p.timestamp * 1000
        : Date.parse(String(p.timestamp));

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


async function onMessage(msg: any) {
  const trade = toTradeInsert(msg);
  if (!trade) return;

  try {
    await insertTrade(trade);
    await updateAggregate(trade);
    await detectMovement(trade);

    console.log(
      `[trade] inserted market=${trade.market_id} side=${trade.side} price=${trade.price} size=${trade.size}`
    );
  } catch (e: any) {
      const msg = e?.message ?? "";
      if (msg.includes("duplicate key value violates unique constraint")) {
          return; // ignore duplicates
      }
      console.error("[trade] insert failed:", msg);
    }
}

const url = process.env.POLYMARKET_WS_URL;
if (!url) throw new Error("Missing POLYMARKET_WS_URL in services/ingestion/.env");

console.log("[ingestion] starting...");

const eventSlug = "israel-strikes-iran-by-january-31-2026";
connectPolymarketWS({
  url,
  subscriptions: [
    {
      topic: "activity",
      type: "trades",
      filters: JSON.stringify({ event_slug: eventSlug }),
    }
  ],
  onMessage
});

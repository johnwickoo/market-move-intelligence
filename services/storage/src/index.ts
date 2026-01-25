import "./db";
import { insertTrade } from "./db";

async function main() {
  await insertTrade({
    id: "test-1",
    market_id: "demo",
    price: 0.5,
    size: 10,
    side: "BUY",
    timestamp: new Date().toISOString(),
    raw: { test: true },
    outcome:"YES",
    outcome_index:80,


  });

  console.log("Inserted test trade");
}

main().catch((err) => {
  console.error("Storage service error:", err);
  process.exit(1);
});

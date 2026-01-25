import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const host = "https://clob.polymarket.com";
const privateKey = process.env.PRIVATE_KEY!;
const signer = new Wallet(privateKey);

// Polygon chain id = 137
const client = new ClobClient(host, 137, signer);

async function main() {
  const apiKey = await client.deriveApiKey();
  console.log(apiKey);
}

main();

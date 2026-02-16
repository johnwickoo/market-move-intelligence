import {
  Connection,
  Keypair,
  clusterApiUrl,
  type Commitment,
} from "@solana/web3.js";
import * as bs58 from "bs58";

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;

const DEFAULT_RPC = clusterApiUrl("devnet");
const COMMITMENT: Commitment = "confirmed";

export function getConnection(): Connection {
  if (_connection) return _connection;
  const rpc = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC;
  _connection = new Connection(rpc, COMMITMENT);
  console.log(`[chain] connected to ${rpc}`);
  return _connection;
}

export function getWallet(): Keypair | null {
  if (_wallet) return _wallet;
  const raw = process.env.SOLANA_PRIVATE_KEY;
  if (!raw) return null;

  try {
    // Try base58 first (Phantom export format)
    const decoded = bs58.default.decode(raw);
    _wallet = Keypair.fromSecretKey(decoded);
  } catch {
    try {
      // Try JSON array (solana-keygen output)
      const arr = JSON.parse(raw) as number[];
      _wallet = Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      console.error("[chain] SOLANA_PRIVATE_KEY is not valid base58 or JSON array");
      return null;
    }
  }

  console.log(`[chain] wallet loaded: ${_wallet.publicKey.toBase58()}`);
  return _wallet;
}

export { COMMITMENT };

import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { getConnection, getWallet, COMMITMENT } from "./solana.client";
import type {
  AttestationInput,
  AttestationResult,
  SignalClassification,
} from "./types";
import { CLASSIFICATION_INDEX } from "./types";

// ── Config ──────────────────────────────────────────────────────────
const ENABLED = process.env.SOLANA_ATTESTATION_ENABLED === "true";
const MODE = (process.env.SOLANA_ATTESTATION_MODE ?? "memo") as
  | "memo"
  | "program";
const PROGRAM_ID = process.env.SOLANA_ATTESTATION_PROGRAM_ID ?? null;
const TIMEOUT_MS = Number(process.env.SOLANA_ATTESTATION_TIMEOUT_MS ?? 10_000);

// Solana Memo Program v2
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// ── Helpers ─────────────────────────────────────────────────────────
function sha256(data: string): Buffer {
  return createHash("sha256").update(data).digest();
}

function buildSignalPayload(input: AttestationInput): string {
  return JSON.stringify({
    mid: input.movement_id,
    mkt: input.market_id,
    cls: input.classification,
    conf: Math.round(input.confidence * 10_000),
    cap: Math.round(input.capital_score * 10_000),
    inf: Math.round(input.info_score * 10_000),
    time: Math.round(input.time_score * 10_000),
    news: Math.round(input.news_score * 10_000),
    ts: Math.floor(Date.now() / 1000),
  });
}

// ── Memo-based attestation ──────────────────────────────────────────
// Writes a compact JSON envelope to the Solana Memo program.
// On-chain proof: tx signature → memo data → verifiable signal record.
async function attestViaMemo(
  input: AttestationInput
): Promise<AttestationResult> {
  const connection = getConnection();
  const wallet = getWallet();
  if (!wallet) throw new Error("SOLANA_PRIVATE_KEY not configured");

  const payload = buildSignalPayload(input);
  const hash = sha256(payload);

  // Memo content: compact JSON with hash + key fields for on-chain readability
  const memo = JSON.stringify({
    v: 1,
    h: hash.toString("hex").slice(0, 16), // first 8 bytes of SHA-256
    mid: input.movement_id.slice(0, 64),
    cls: input.classification,
    conf: Math.round(input.confidence * 10_000),
    ts: Math.floor(Date.now() / 1000),
  });

  const memoData = Buffer.from(memo, "utf-8");

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(COMMITMENT);

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      {
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        ],
        programId: MEMO_PROGRAM_ID,
        data: memoData,
      },
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  const txSignature = await connection.sendTransaction(tx, {
    maxRetries: 2,
  });

  const confirmation = await connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    COMMITMENT
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return {
    txSignature,
    slot: confirmation.context.slot,
    mode: "memo",
  };
}

// ── Program-based attestation (placeholder) ─────────────────────────
// Uses the custom Anchor program with PDA accounts for structured on-chain storage.
// Requires deploying programs/signal-attestation first.
async function attestViaProgram(
  input: AttestationInput
): Promise<AttestationResult> {
  if (!PROGRAM_ID) {
    throw new Error(
      "SOLANA_ATTESTATION_PROGRAM_ID not set — deploy the Anchor program first"
    );
  }

  const connection = getConnection();
  const wallet = getWallet();
  if (!wallet) throw new Error("SOLANA_PRIVATE_KEY not configured");

  const programId = new PublicKey(PROGRAM_ID);
  const payload = buildSignalPayload(input);
  const signalHash = sha256(payload);
  const marketIdHash = sha256(input.market_id);
  const movementIdHash = sha256(input.movement_id);

  // Derive PDA: ["attestation", authority, movement_id_hash]
  const [attestationPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("attestation"),
      wallet.publicKey.toBuffer(),
      movementIdHash,
    ],
    programId
  );

  // Anchor instruction discriminator: sha256("global:record_signal")[0..8]
  const discriminator = sha256("global:record_signal").subarray(0, 8);

  // Serialize params manually (matching Anchor's borsh layout)
  const classIdx = CLASSIFICATION_INDEX[input.classification] ?? 0;
  const confBps = Math.round(input.confidence * 10_000);
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  const paramsBuf = Buffer.alloc(32 + 32 + 32 + 1 + 2 + 8);
  let offset = 0;
  signalHash.copy(paramsBuf, offset);     offset += 32;
  marketIdHash.copy(paramsBuf, offset);   offset += 32;
  movementIdHash.copy(paramsBuf, offset); offset += 32;
  paramsBuf.writeUInt8(classIdx, offset);  offset += 1;
  paramsBuf.writeUInt16LE(confBps, offset); offset += 2;
  paramsBuf.writeBigInt64LE(timestamp, offset);

  const data = Buffer.concat([discriminator, paramsBuf]);

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(COMMITMENT);

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      {
        keys: [
          { pubkey: attestationPDA, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: new PublicKey("11111111111111111111111111111111"),
            isSigner: false,
            isWritable: false,
          },
        ],
        programId,
        data,
      },
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([wallet]);

  const txSignature = await connection.sendTransaction(tx, {
    maxRetries: 2,
  });

  const confirmation = await connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    COMMITMENT
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return {
    txSignature,
    slot: confirmation.context.slot,
    mode: "program",
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Attest a scored signal on Solana. Fire-and-forget from the signal pipeline.
 *
 * Returns the tx signature + slot on success, or null if disabled/failed.
 * Never throws — attestation failure must not break the detection pipeline.
 */
export async function attestSignal(
  input: AttestationInput
): Promise<AttestationResult | null> {
  if (!ENABLED) return null;

  try {
    const attestFn = MODE === "program" ? attestViaProgram : attestViaMemo;

    const result = await Promise.race([
      attestFn(input),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("attestation timeout")), TIMEOUT_MS)
      ),
    ]);

    console.log(
      `[chain] attested ${input.movement_id} → ${result.txSignature.slice(0, 16)}… (slot ${result.slot}, ${result.mode})`
    );

    return result;
  } catch (err: any) {
    console.warn(
      `[chain] attestation failed (non-blocking):`,
      err?.message ?? err
    );
    return null;
  }
}

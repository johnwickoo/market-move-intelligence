import * as assert from "node:assert/strict";
import { deriveEntityContext } from "../src/entity";

// ── Crypto detection ─────────────────────────────────────────────────

{
  const ctx = deriveEntityContext("Will BTC reach $100k by end of year?");
  assert.equal(ctx.category, "crypto");
  assert.equal(ctx.canonicalEntity, "Bitcoin");
  assert.ok(ctx.entityTerms.includes("BTC"));
  assert.ok(ctx.entityTerms.includes("Bitcoin"));
}

{
  const ctx = deriveEntityContext("Ethereum ETF approval odds");
  assert.equal(ctx.category, "crypto");
  // Should match both Ethereum and ETF
  assert.ok(ctx.entityTerms.includes("ETH"));
  assert.ok(ctx.entityTerms.includes("ETF"));
}

{
  const ctx = deriveEntityContext("SOL price prediction market");
  assert.equal(ctx.category, "crypto");
  assert.equal(ctx.canonicalEntity, "Solana");
}

// ── Macro / economy ──────────────────────────────────────────────────

{
  const ctx = deriveEntityContext("Will the Fed cut interest rates in March?");
  assert.equal(ctx.category, "macro");
  assert.ok(ctx.entityTerms.includes("Fed"));
  assert.ok(ctx.entityTerms.includes("interest rate"));
}

{
  const ctx = deriveEntityContext("CPI data release impact on markets");
  assert.equal(ctx.category, "macro");
  assert.equal(ctx.canonicalEntity, "CPI");
}

// ── Elections / politics ─────────────────────────────────────────────

{
  const ctx = deriveEntityContext("Will Trump win the 2024 election?");
  assert.equal(ctx.category, "elections");
  assert.ok(ctx.entityTerms.includes("Trump"));
  assert.ok(ctx.entityTerms.includes("election"));
}

{
  const ctx = deriveEntityContext("Government shutdown probability");
  assert.equal(ctx.category, "elections");
  assert.ok(ctx.entityTerms.includes("government shutdown"));
}

// ── Geopolitics ──────────────────────────────────────────────────────

{
  const ctx = deriveEntityContext("Ukraine ceasefire agreement");
  assert.equal(ctx.category, "geopolitics");
  assert.ok(ctx.entityTerms.includes("Ukraine"));
}

{
  const ctx = deriveEntityContext("China Taiwan strait tensions");
  assert.equal(ctx.category, "geopolitics");
}

// ── Sports ───────────────────────────────────────────────────────────

{
  const ctx = deriveEntityContext("NBA Finals winner 2025");
  assert.equal(ctx.category, "sports");
  assert.ok(ctx.entityTerms.includes("NBA"));
}

{
  const ctx = deriveEntityContext("Super Bowl LXII champion");
  assert.equal(ctx.category, "sports");
  assert.ok(ctx.entityTerms.includes("Super Bowl"));
}

// ── Fallback (other) ─────────────────────────────────────────────────

{
  const ctx = deriveEntityContext("Will it rain tomorrow in Tokyo?");
  assert.equal(ctx.category, "other");
  assert.ok(ctx.entityTerms.length > 0); // should extract key words
}

// ── Event slug enrichment ────────────────────────────────────────────

{
  const ctx = deriveEntityContext(
    "Price prediction",
    "bitcoin-price-above-100k"
  );
  assert.equal(ctx.category, "crypto");
  assert.ok(ctx.entityTerms.includes("Bitcoin"));
}

console.log("entity.test.ts: ok");

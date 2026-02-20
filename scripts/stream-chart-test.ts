#!/usr/bin/env npx tsx
/**
 * Terminal SSE Chart Test
 *
 * Connects to the same /api/stream endpoint the frontend uses,
 * collects ticks, and renders a live ASCII chart in the terminal.
 * This tests the data pipeline independently of React/lightweight-charts.
 *
 * Usage:
 *   npx tsx scripts/stream-chart-test.ts
 *   npx tsx scripts/stream-chart-test.ts --slug=btc-updown-15m-1771484400
 *   npx tsx scripts/stream-chart-test.ts --market_id=0xABC123
 *   npx tsx scripts/stream-chart-test.ts --minutes=5
 */

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3005";

const args = Object.fromEntries(
  process.argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    })
);

const slug = args.slug ?? "";
const marketId = args.market_id ?? "";
const minutes = Number(args.minutes ?? 10);

if (!slug && !marketId) {
  console.log("Usage: npx tsx scripts/stream-chart-test.ts --slug=<slug> [--minutes=5]");
  console.log("   or: npx tsx scripts/stream-chart-test.ts --market_id=<id>");
  console.log("\nWill auto-detect from tracked_slugs...");
}

// ── Types ────────────────────────────────────────────────────────────

type TickEvent = {
  market_id: string;
  outcome: string | null;
  ts: string;
  mid: number;
  asset_id: string | null;
  bucketMinutes: number;
};

type TradeEvent = {
  market_id: string;
  outcome: string | null;
  ts: string;
  size: number;
  side: string | null;
};

// ── State ────────────────────────────────────────────────────────────

const ticks: TickEvent[] = [];
const trades: TradeEvent[] = [];
let tickCount = 0;
let tradeCount = 0;
let moveCount = 0;
let errorCount = 0;
let lastTickMs = 0;
const startMs = Date.now();

// Per-minute buckets: minute ISO → { price, tickCount }
const minuteBuckets = new Map<string, { price: number; count: number; minPrice: number; maxPrice: number }>();

function toBucketKey(tsMs: number): string {
  const d = new Date(Math.floor(tsMs / 60_000) * 60_000);
  return d.toISOString().slice(11, 16); // HH:MM
}

function processTickForChart(tick: TickEvent) {
  const tsMs = Date.parse(tick.ts);
  if (!Number.isFinite(tsMs)) return;

  const key = toBucketKey(tsMs);
  const existing = minuteBuckets.get(key);
  if (existing) {
    existing.price = tick.mid; // last price wins (same as frontend)
    existing.count++;
    existing.minPrice = Math.min(existing.minPrice, tick.mid);
    existing.maxPrice = Math.max(existing.maxPrice, tick.mid);
  } else {
    minuteBuckets.set(key, {
      price: tick.mid,
      count: 1,
      minPrice: tick.mid,
      maxPrice: tick.mid,
    });
  }
}

// ── ASCII Chart ──────────────────────────────────────────────────────

function renderChart() {
  const WIDTH = 70;
  const HEIGHT = 15;

  if (minuteBuckets.size === 0) {
    console.log("  (no data yet)");
    return;
  }

  // Sort buckets by time
  const sorted = [...minuteBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Take last WIDTH buckets
  const visible = sorted.slice(-WIDTH);

  const prices = visible.map(([, v]) => v.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = maxP - minP || 0.001;

  // Build grid
  const grid: string[][] = Array.from({ length: HEIGHT }, () =>
    Array(visible.length).fill(" ")
  );

  for (let col = 0; col < visible.length; col++) {
    const price = visible[col][1].price;
    const row = Math.floor((1 - (price - minP) / range) * (HEIGHT - 1));
    grid[row][col] = "●";
  }

  // Render
  for (let row = 0; row < HEIGHT; row++) {
    const priceLabel =
      row === 0
        ? maxP.toFixed(3).padStart(7)
        : row === HEIGHT - 1
          ? minP.toFixed(3).padStart(7)
          : "       ";
    console.log(`  ${priceLabel} │${grid[row].join("")}`);
  }

  // X-axis
  const first = visible[0][0];
  const last = visible[visible.length - 1][0];
  const mid = visible[Math.floor(visible.length / 2)]?.[0] ?? "";
  const axis = first.padEnd(Math.floor(visible.length / 2)) +
    mid.padEnd(visible.length - Math.floor(visible.length / 2) - first.length) +
    last;
  console.log(`          └${"─".repeat(visible.length)}`);
  console.log(`           ${axis}`);
}

// ── SSE Connection ───────────────────────────────────────────────────

async function connect() {
  const streamUrl = marketId
    ? `${BASE_URL}/api/stream?market_id=${encodeURIComponent(marketId)}&bucketMinutes=1`
    : slug
      ? `${BASE_URL}/api/stream?slugs=${encodeURIComponent(slug)}&bucketMinutes=1`
      : `${BASE_URL}/api/stream?slugs=&bucketMinutes=1`;

  console.log(`\n🔌 Connecting to: ${streamUrl}`);
  console.log(`   Duration: ${minutes} minutes\n`);

  const res = await fetch(streamUrl, {
    headers: { Accept: "text/event-stream" },
  });

  if (!res.ok || !res.body) {
    console.error(`Failed to connect: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (line: string) => {
    if (line.startsWith("event: ")) {
      buffer = line.slice(7).trim();
    } else if (line.startsWith("data: ") && buffer) {
      const eventType = buffer;
      buffer = "";
      try {
        const data = JSON.parse(line.slice(6));
        switch (eventType) {
          case "tick": {
            tickCount++;
            lastTickMs = Date.now();
            ticks.push(data);
            if (ticks.length > 5000) ticks.splice(0, 1000);
            processTickForChart(data);
            break;
          }
          case "trade": {
            tradeCount++;
            trades.push(data);
            if (trades.length > 1000) trades.splice(0, 500);
            break;
          }
          case "movement": {
            moveCount++;
            break;
          }
          case "error": {
            errorCount++;
            console.error(`  ⚠ Stream error: ${data.message}`);
            break;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  };

  // Read loop
  const readLoop = async () => {
    let partial = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("\n  Stream ended.");
        break;
      }
      partial += decoder.decode(value, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) processLine(line.trim());
      }
    }
  };

  // Start read loop (non-blocking)
  readLoop().catch((err) => {
    console.error(`\n  Stream read error: ${err.message}`);
  });

  // Render loop
  const renderInterval = setInterval(() => {
    console.clear();
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    const sinceLastTick = lastTickMs ? ((Date.now() - lastTickMs) / 1000).toFixed(1) : "n/a";
    const tickRate = (tickCount / (Number(elapsed) || 1)).toFixed(1);

    console.log("═══════════════════════════════════════════════════════════════════");
    console.log("  TERMINAL STREAM CHART TEST");
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log(
      `  Elapsed: ${elapsed}s | Ticks: ${tickCount} (${tickRate}/s)` +
      ` | Trades: ${tradeCount} | Moves: ${moveCount} | Errors: ${errorCount}`
    );
    console.log(`  Last tick: ${sinceLastTick}s ago | Buckets: ${minuteBuckets.size}`);

    if (ticks.length > 0) {
      const last = ticks[ticks.length - 1];
      console.log(
        `  Latest: mid=${last.mid.toFixed(4)} outcome=${last.outcome}` +
        ` market=${last.market_id.slice(0, 20)} ts=${last.ts}`
      );
    }

    console.log("───────────────────────────────────────────────────────────────────");
    renderChart();
    console.log("───────────────────────────────────────────────────────────────────");

    // Show last 10 ticks
    console.log("  Recent ticks:");
    const recent = ticks.slice(-10);
    for (const t of recent) {
      const tsShort = t.ts.slice(11, 23);
      console.log(
        `    ${tsShort} mid=${t.mid.toFixed(4)} outcome=${t.outcome ?? "n/a"}` +
        ` market=${t.market_id.slice(0, 16)}`
      );
    }

    // Show bucket summary
    console.log("\n  Minute buckets (last 10):");
    const bucketList = [...minuteBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-10);
    for (const [time, b] of bucketList) {
      console.log(
        `    ${time}: price=${b.price.toFixed(4)} ticks=${b.count}` +
        ` range=[${b.minPrice.toFixed(4)}–${b.maxPrice.toFixed(4)}]`
      );
    }
  }, 2000);

  // Stop after duration
  setTimeout(() => {
    clearInterval(renderInterval);
    reader.cancel();
    console.log("\n\n═══════════════════════════════════════════════════════════════════");
    console.log("  FINAL SUMMARY");
    console.log("═══════════════════════════════════════════════════════════════════");
    console.log(`  Duration: ${((Date.now() - startMs) / 60_000).toFixed(1)} minutes`);
    console.log(`  Total ticks: ${tickCount}`);
    console.log(`  Total trades: ${tradeCount}`);
    console.log(`  Total movements: ${moveCount}`);
    console.log(`  Errors: ${errorCount}`);
    console.log(`  Minute buckets: ${minuteBuckets.size}`);
    console.log("\n  All minute buckets:");
    const allBuckets = [...minuteBuckets.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    for (const [time, b] of allBuckets) {
      console.log(
        `    ${time}: close=${b.price.toFixed(4)} ticks=${b.count}` +
        ` range=[${b.minPrice.toFixed(4)}–${b.maxPrice.toFixed(4)}]`
      );
    }
    console.log("\nDone.");
    process.exit(0);
  }, minutes * 60_000);
}

connect().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

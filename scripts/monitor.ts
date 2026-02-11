#!/usr/bin/env npx tsx
/**
 * Terminal Monitor for Market Move Intelligence
 *
 * Usage:
 *   npx tsx scripts/monitor.ts           # one-shot dashboard
 *   npx tsx scripts/monitor.ts --watch   # auto-refresh every 10s
 */
import { config } from "dotenv";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const root = resolve(__dirname, "..");

// Load env from multiple locations (project root, then apps/web)
// quiet: true suppresses dotenv v17 log output
const opts = { quiet: true } as any;
config({ ...opts, path: resolve(root, ".env") });
config({ ...opts, path: resolve(root, ".env.local") });
config({ ...opts, path: resolve(root, "apps/web/.env.local") });
config({ ...opts, path: resolve(root, "apps/web/.env") });

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const NEXT_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const WATCH = process.argv.includes("--watch");
const REFRESH_MS = 10_000;

// ── helpers ──────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const BG_DARK = "\x1b[48;5;234m";

function ok(msg: string) {
  return `${GREEN}✓${RESET} ${msg}`;
}
function fail(msg: string) {
  return `${RED}✗${RESET} ${msg}`;
}
function warn(msg: string) {
  return `${YELLOW}!${RESET} ${msg}`;
}
function dim(msg: string) {
  return `${DIM}${msg}${RESET}`;
}
function badge(label: string, color: string) {
  return `${color}${BG_DARK} ${label} ${RESET}`;
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0) return "future";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / 86_400_000).toFixed(1)}d ago`;
}

async function pgFetch<T = unknown>(path: string): Promise<T | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function httpCheck(
  url: string,
  headers?: Record<string, string>
): Promise<{ ok: boolean; ms: number; status?: number }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers });
    return { ok: res.ok, ms: Date.now() - start, status: res.status };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}

// ── data fetchers ────────────────────────────────────────────────────

type TickRow = { market_id: string; outcome: string | null; ts: string; mid: number | null; asset_id?: string | null };
type TradeRow = { market_id: string; outcome: string | null; timestamp: string; size?: number; side?: string };
type MovementRow = { id: string; market_id: string; outcome: string | null; window_end: string; reason: string; window_type: string };
type DominantRow = { market_id: string; outcome: string | null };

async function getLatestTicks(): Promise<TickRow[]> {
  return (await pgFetch<TickRow[]>(
    "market_mid_ticks?select=market_id,outcome,asset_id,ts,mid&order=ts.desc&limit=20"
  )) ?? [];
}

async function getLatestTrades(): Promise<TradeRow[]> {
  return (await pgFetch<TradeRow[]>(
    "trades?select=market_id,outcome,timestamp,size,side&order=timestamp.desc&limit=20"
  )) ?? [];
}

async function getRecentMovements(): Promise<MovementRow[]> {
  return (await pgFetch<MovementRow[]>(
    "market_movements?select=id,market_id,outcome,window_end,reason,window_type&order=window_end.desc&limit=10"
  )) ?? [];
}

async function getDominantOutcomes(): Promise<DominantRow[]> {
  return (await pgFetch<DominantRow[]>(
    "market_dominant_outcomes?select=market_id,outcome"
  )) ?? [];
}

async function getTableCount(table: string): Promise<number | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=0`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok) return null;
    const range = res.headers.get("content-range");
    if (!range) return null;
    const total = range.split("/")[1];
    return total === "*" ? null : Number(total);
  } catch {
    return null;
  }
}

// ── dashboard ────────────────────────────────────────────────────────

async function render() {
  const width = Math.min(process.stdout.columns || 80, 100);
  const hr = dim("─".repeat(width));
  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push("");
  push(`${BOLD}${CYAN}  ╔══════════════════════════════════════════════════════╗${RESET}`);
  push(`${BOLD}${CYAN}  ║      MARKET MOVE INTELLIGENCE  ·  MONITOR          ║${RESET}`);
  push(`${BOLD}${CYAN}  ╚══════════════════════════════════════════════════════╝${RESET}`);
  push(`  ${dim(now)}${WATCH ? dim("  (auto-refresh)") : ""}`);
  push("");

  // ── ENV CHECK ──
  push(`  ${BOLD}ENVIRONMENT${RESET}`);
  push(hr);
  const envVars = [
    ["SUPABASE_URL", SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_KEY],
    ["POLYMARKET_WS_URL", process.env.POLYMARKET_WS_URL ?? ""],
    ["POLYMARKET_EVENT_SLUGS", process.env.POLYMARKET_EVENT_SLUGS ?? ""],
    ["NEXT_PUBLIC_TRACKED_SLUG", process.env.NEXT_PUBLIC_TRACKED_SLUG ?? ""],
    ["NEXT_PUBLIC_PIN_MARKET_ID", process.env.NEXT_PUBLIC_PIN_MARKET_ID ?? ""],
    ["NEXT_PUBLIC_PIN_ASSET_ID", process.env.NEXT_PUBLIC_PIN_ASSET_ID ?? ""],
  ] as const;

  for (const [name, val] of envVars) {
    if (val) {
      const display = name.includes("KEY") ? val.slice(0, 8) + "…" : val.slice(0, 50);
      push(`  ${ok(name.padEnd(30))} ${dim(display)}`);
    } else {
      const critical = name === "SUPABASE_URL" || name === "SUPABASE_SERVICE_ROLE_KEY";
      push(`  ${critical ? fail(name.padEnd(30) + " MISSING") : warn(name.padEnd(30) + " not set")}`);
    }
  }
  push("");

  // ── CONNECTIVITY ──
  push(`  ${BOLD}CONNECTIVITY${RESET}`);
  push(hr);

  const [supaHealth, nextHealth] = await Promise.all([
    SUPABASE_URL && SUPABASE_KEY
      ? httpCheck(`${SUPABASE_URL}/rest/v1/market_mid_ticks?select=ts&limit=1`, {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        })
      : Promise.resolve({ ok: false, ms: 0 }),
    httpCheck(NEXT_URL),
  ]);

  push(`  ${supaHealth.ok ? ok("Supabase REST API") : fail("Supabase REST API")}  ${dim(`${supaHealth.ms}ms`)}`);
  push(`  ${nextHealth.ok ? ok("Next.js frontend ") : fail("Next.js frontend ")}  ${dim(`${nextHealth.ms}ms${nextHealth.status ? ` (${nextHealth.status})` : ""}`)}`);
  push("");

  // ── DATABASE TABLES ──
  push(`  ${BOLD}DATABASE TABLES${RESET}`);
  push(hr);

  const tables = ["trades", "market_mid_ticks", "market_movements", "movement_explanations", "market_dominant_outcomes", "market_aggregates"];
  const counts = await Promise.all(tables.map(getTableCount));
  for (let i = 0; i < tables.length; i++) {
    const c = counts[i];
    const name = tables[i].padEnd(28);
    if (c === null) {
      push(`  ${warn(name)} ${dim("unable to count")}`);
    } else if (c === 0) {
      push(`  ${warn(name)} ${YELLOW}empty${RESET}`);
    } else {
      push(`  ${ok(name)} ${c.toLocaleString()} rows`);
    }
  }
  push("");

  // ── LATEST TICKS ──
  const ticks = await getLatestTicks();
  push(`  ${BOLD}LATEST MID TICKS${RESET}  ${dim(`(${ticks.length} shown)`)}`);
  push(hr);
  if (ticks.length === 0) {
    push(`  ${dim("No ticks found")}`);
  } else {
    push(`  ${dim("market_id".padEnd(12))}  ${dim("outcome".padEnd(8))}  ${dim("mid".padEnd(8))}  ${dim("age")}`);
    const shown = new Set<string>();
    for (const tk of ticks) {
      const key = `${tk.market_id}:${tk.outcome}`;
      if (shown.has(key)) continue;
      shown.add(key);
      if (shown.size > 8) break;
      const mid = tk.mid != null ? tk.mid.toFixed(4) : "null";
      const mId = tk.market_id.slice(0, 10) + "…";
      const out = (tk.outcome ?? "—").padEnd(8);
      push(`  ${mId.padEnd(12)}  ${out}  ${mid.padEnd(8)}  ${ago(tk.ts)}`);
    }
  }
  push("");

  // ── LATEST TRADES ──
  const trades = await getLatestTrades();
  push(`  ${BOLD}LATEST TRADES${RESET}  ${dim(`(${trades.length} shown)`)}`);
  push(hr);
  if (trades.length === 0) {
    push(`  ${dim("No trades found")}`);
  } else {
    push(`  ${dim("market_id".padEnd(12))}  ${dim("side".padEnd(5))}  ${dim("size".padEnd(10))}  ${dim("age")}`);
    for (const tr of trades.slice(0, 8)) {
      const mId = tr.market_id.slice(0, 10) + "…";
      const side = (tr.side ?? "—").padEnd(5);
      const size = (tr.size?.toFixed(2) ?? "—").padEnd(10);
      push(`  ${mId.padEnd(12)}  ${side}  ${size}  ${ago(tr.timestamp)}`);
    }
  }
  push("");

  // ── RECENT MOVEMENTS ──
  const movements = await getRecentMovements();
  push(`  ${BOLD}RECENT MOVEMENTS / SIGNALS${RESET}  ${dim(`(${movements.length})`)}`);
  push(hr);
  if (movements.length === 0) {
    push(`  ${dim("No movements detected")}`);
  } else {
    for (const mv of movements.slice(0, 6)) {
      const typeLabel = mv.window_type === "event"
        ? badge("MOVEMENT", MAGENTA)
        : badge("SIGNAL", YELLOW);
      const reason = badge(mv.reason, CYAN);
      const mId = mv.market_id.slice(0, 10) + "…";
      push(`  ${typeLabel} ${reason}  ${mId}  ${dim(mv.outcome ?? "—")}  ${dim(ago(mv.window_end))}`);
    }
  }
  push("");

  // ── DOMINANT OUTCOMES ──
  const dominants = await getDominantOutcomes();
  push(`  ${BOLD}DOMINANT OUTCOMES${RESET}  ${dim(`(${dominants.length} markets)`)}`);
  push(hr);
  if (dominants.length === 0) {
    push(`  ${dim("No dominant outcomes set")}`);
  } else {
    for (const d of dominants.slice(0, 8)) {
      const mId = d.market_id.slice(0, 10) + "…";
      push(`  ${mId.padEnd(12)}  → ${BOLD}${d.outcome ?? "—"}${RESET}`);
    }
  }
  push("");

  // ── FRESHNESS SUMMARY ──
  push(`  ${BOLD}DATA FRESHNESS${RESET}`);
  push(hr);
  const latestTickTs = ticks[0]?.ts;
  const latestTradeTs = trades[0]?.timestamp;
  const latestMoveTs = movements[0]?.window_end;

  if (latestTickTs) {
    const tickMs = Date.now() - Date.parse(latestTickTs);
    const stale = tickMs > 120_000;
    push(`  ${stale ? warn("Last tick:     ") : ok("Last tick:     ")} ${ago(latestTickTs)}${stale ? `  ${RED}(>2m stale — ingestion may be down)${RESET}` : ""}`);
  } else {
    push(`  ${fail("Last tick:      no data")}`);
  }
  if (latestTradeTs) {
    const tradeMs = Date.now() - Date.parse(latestTradeTs);
    const stale = tradeMs > 300_000;
    push(`  ${stale ? warn("Last trade:    ") : ok("Last trade:    ")} ${ago(latestTradeTs)}${stale ? `  ${YELLOW}(>5m — low volume or ingestion paused)${RESET}` : ""}`);
  } else {
    push(`  ${fail("Last trade:     no data")}`);
  }
  if (latestMoveTs) {
    push(`  ${ok("Last movement: ")} ${ago(latestMoveTs)}`);
  } else {
    push(`  ${dim("  Last movement:  none detected yet")}`);
  }
  push("");
  push(hr);
  push("");

  // output
  if (WATCH) process.stdout.write("\x1b[2J\x1b[H"); // clear screen
  process.stdout.write(lines.join("\n") + "\n");
}

async function main() {
  await render();
  if (WATCH) {
    setInterval(render, REFRESH_MS);
  }
}

main().catch((err) => {
  console.error("Monitor error:", err);
  process.exit(1);
});

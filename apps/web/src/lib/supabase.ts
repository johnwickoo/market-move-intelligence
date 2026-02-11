// ── Shared types for Supabase row shapes ────────────────────────────

export type RawTrade = {
  market_id: string;
  outcome: string | null;
  timestamp: string;
  size?: number;
  side?: string;
  raw?: any;
};

export type RawTick = {
  market_id: string;
  outcome: string | null;
  asset_id?: string | null;
  ts: string;
  mid: number | null;
};

export type RawMovement = {
  id: string;
  market_id: string;
  outcome: string | null;
  window_start: string;
  window_end: string;
  window_type: "24h" | "event";
  reason: string;
};

export type DominantOutcomeRow = {
  market_id: string;
  outcome: string | null;
};

// ── Shared helpers ──────────────────────────────────────────────────

export function getEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

export async function pgFetch<T = unknown>(path: string): Promise<T> {
  const url = `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function pgPost<T = unknown>(
  path: string,
  body: unknown
): Promise<T> {
  const url = `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase POST error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function toNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

export function slugFromRaw(raw: any): string | null {
  const payload = raw?.payload ?? raw;
  return (
    payload?.eventSlug ??
    payload?.slug ??
    payload?.marketSlug ??
    payload?.market_slug ??
    null
  );
}

export function titleFromRaw(raw: any): string | null {
  const payload = raw?.payload ?? raw;
  return payload?.title ?? payload?.market_title ?? null;
}

export function colorForOutcome(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === "yes" || normalized === "up") return "#ff6a3d";
  if (normalized === "no" || normalized === "down") return "#3a6bff";
  return "#9aa3b8";
}

export async function fetchDominantOutcomes(
  marketIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (marketIds.length === 0) return map;
  try {
    const rows = (await pgFetch(
      `market_dominant_outcomes?select=market_id,outcome` +
        `&market_id=in.(${marketIds.join(",")})`
    )) as DominantOutcomeRow[];
    for (const row of rows) {
      if (row.outcome) map.set(row.market_id, String(row.outcome));
    }
  } catch {
    // ignore dominant lookup failures
  }
  return map;
}

export async function fetchExplanations(
  movementIds: string[]
): Promise<Record<string, string>> {
  if (movementIds.length === 0) return {};
  try {
    const rows = (await pgFetch(
      `movement_explanations?select=movement_id,text` +
        `&movement_id=in.(${movementIds.map(encodeURIComponent).join(",")})`
    )) as { movement_id: string; text: string }[];
    return Object.fromEntries(rows.map((r) => [r.movement_id, r.text]));
  } catch {
    return {};
  }
}

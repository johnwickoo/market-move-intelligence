export type TimeScoreInput = {
  targetMs: number | null;
  resolved: boolean;
  status?: string | null;
  nowMs?: number;
  horizonHours?: number;
};

const RESOLVED_STATUSES = new Set(["resolved", "closed", "settled", "ended"]);

export function parseTimeValue(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      return n < 10_000_000_000 ? n * 1000 : n;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function computeTimeScore(input: TimeScoreInput): number {
  const nowMs = input.nowMs ?? Date.now();
  const horizonHours = Math.max(1, input.horizonHours ?? 72);

  if (input.resolved) return 1;
  if (input.status) {
    const s = input.status.toLowerCase();
    if (RESOLVED_STATUSES.has(s)) return 1;
  }
  if (input.targetMs == null) return 0;

  const horizonMs = horizonHours * 60 * 60 * 1000;
  const deltaMs = input.targetMs - nowMs;
  if (deltaMs <= 0) return 1;
  if (deltaMs >= horizonMs) return 0;
  return Math.max(0, Math.min(1, 1 - deltaMs / horizonMs));
}

import * as assert from "node:assert/strict";
import { computeNewsTimeRange, getWindowConfig } from "../src/timeWindow";

// ── getWindowConfig ──────────────────────────────────────────────────

{
  const cfg5m = getWindowConfig("5m");
  assert.equal(cfg5m.lookbackMs, 60 * 60_000); // 1h
}

{
  const cfg15m = getWindowConfig("15m");
  assert.equal(cfg15m.lookbackMs, 4 * 60 * 60_000); // 4h
}

{
  const cfg1h = getWindowConfig("1h");
  assert.equal(cfg1h.lookbackMs, 12 * 60 * 60_000); // 12h
}

{
  const cfg4h = getWindowConfig("4h");
  assert.equal(cfg4h.lookbackMs, 48 * 60 * 60_000); // 48h
}

{
  const cfgEvent = getWindowConfig("event");
  assert.equal(cfgEvent.lookbackMs, 24 * 60 * 60_000); // 24h
}

{
  // Unknown window type falls back to 24h
  const cfgUnknown = getWindowConfig("unknown");
  assert.equal(cfgUnknown.lookbackMs, 24 * 60 * 60_000);
}

// ── computeNewsTimeRange ─────────────────────────────────────────────

{
  const windowEnd = "2026-02-17T12:00:00.000Z";
  const { fromDate, toDate, lookbackMs, bucketKey } = computeNewsTimeRange(
    windowEnd,
    "5m"
  );

  // 1h lookback from noon → 11:00 same day
  assert.equal(fromDate, "2026-02-17");
  assert.equal(toDate, "2026-02-17");
  assert.equal(lookbackMs, 60 * 60_000);
  assert.ok(bucketKey > 0);
}

{
  const windowEnd = "2026-02-17T02:00:00.000Z";
  const { fromDate } = computeNewsTimeRange(windowEnd, "4h");

  // 48h lookback from 2am Feb 17 → Feb 15
  assert.equal(fromDate, "2026-02-15");
}

console.log("timeWindow.test.ts: ok");

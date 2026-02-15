import * as assert from "node:assert/strict";
import { computeTimeScore, parseTimeValue } from "../src/timeScore";

const now = Date.parse("2026-02-12T00:00:00.000Z");
const horizonHours = 72;
const horizonMs = horizonHours * 60 * 60 * 1000;

// parseTimeValue
assert.equal(parseTimeValue("1700000000"), 1700000000 * 1000);
assert.equal(parseTimeValue(1700000000000), 1700000000000);
assert.equal(
  parseTimeValue("2026-02-12T00:00:00.000Z"),
  Date.parse("2026-02-12T00:00:00.000Z")
);

// computeTimeScore
assert.equal(
  computeTimeScore({
    targetMs: null,
    resolved: false,
    status: null,
    nowMs: now,
    horizonHours,
  }),
  0
);

assert.equal(
  computeTimeScore({
    targetMs: now - 1000,
    resolved: false,
    status: null,
    nowMs: now,
    horizonHours,
  }),
  1
);

assert.equal(
  computeTimeScore({
    targetMs: now + horizonMs,
    resolved: false,
    status: null,
    nowMs: now,
    horizonHours,
  }),
  0
);

assert.equal(
  computeTimeScore({
    targetMs: now + horizonMs / 2,
    resolved: false,
    status: null,
    nowMs: now,
    horizonHours,
  }),
  0.5
);

assert.equal(
  computeTimeScore({
    targetMs: now + horizonMs,
    resolved: true,
    status: null,
    nowMs: now,
    horizonHours,
  }),
  1
);

assert.equal(
  computeTimeScore({
    targetMs: now + horizonMs,
    resolved: false,
    status: "resolved",
    nowMs: now,
    horizonHours,
  }),
  1
);

console.log("timeScore.test.ts: ok");

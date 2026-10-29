// Run: node --test test/bands.test.mjs
// Band math absorbed from context-guard (decision 13) — now part of the single
// owner of the context lifecycle (session-transfer).
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BAND_CONFIG,
  bandConfigFromEnv,
  bandFor,
  bandRank,
  bandThresholds,
  criticalThresholdFor,
  currentPercent,
  guidelineFor,
  shouldNotify,
  thresholdFor,
} from "../core/gate.ts";

const WINDOW = 262144;
const usage = (tokens, contextWindow = WINDOW) => ({ tokens, contextWindow, percent: null });

test("threshold math on a 262144 window: 150K warns, 120K is ok", () => {
  assert.equal(thresholdFor(WINDOW), 150_000, "0.70*262144 capped at 150K");
  assert.equal(criticalThresholdFor(WINDOW), 200_000, "0.85*262144 capped at 200K");
  assert.equal(bandFor(usage(150_000), DEFAULT_BAND_CONFIG), "warn");
  assert.equal(bandFor(usage(120_000), DEFAULT_BAND_CONFIG), "ok");
  assert.equal(bandFor(usage(200_000), DEFAULT_BAND_CONFIG), "critical");
  assert.equal(bandFor(usage(199_999), DEFAULT_BAND_CONFIG), "warn");
});

test("env override takes absolute token precedence over the formula", () => {
  const cfg = bandConfigFromEnv({
    CONTEXT_GUARD_WARN_TOKENS: "100000",
    CONTEXT_GUARD_CRITICAL_TOKENS: "110000",
  });
  assert.deepEqual(cfg, { warnTokens: 100_000, criticalTokens: 110_000 });
  assert.equal(bandFor(usage(100_000), cfg), "warn");
  assert.equal(bandFor(usage(99_999), cfg), "ok");
  assert.equal(bandFor(usage(110_000), cfg), "critical");
});

test("env override applies on a small window where the formula would differ", () => {
  const cfg = bandConfigFromEnv({ CONTEXT_GUARD_WARN_TOKENS: "5000" });
  assert.deepEqual(cfg, { warnTokens: 5_000, criticalTokens: null });
  assert.equal(bandFor(usage(5_000, 8_000), cfg), "warn");
  assert.equal(bandFor(usage(4_999, 8_000), cfg), "ok");
});

test("bad env values fall back to the formula", () => {
  assert.deepEqual(bandConfigFromEnv({ CONTEXT_GUARD_WARN_TOKENS: "abc" }), DEFAULT_BAND_CONFIG);
  assert.deepEqual(bandConfigFromEnv({ CONTEXT_GUARD_WARN_TOKENS: "-5" }), DEFAULT_BAND_CONFIG);
  assert.deepEqual(bandConfigFromEnv({}), DEFAULT_BAND_CONFIG);
});

test("fail-silent on unknown usage: undefined and null tokens are ok", () => {
  assert.equal(bandFor(undefined), "ok");
  assert.equal(bandFor({ tokens: null, contextWindow: WINDOW, percent: null }), "ok");
  assert.equal(guidelineFor("ok", undefined), null);
  assert.equal(guidelineFor("warn", { tokens: null, contextWindow: WINDOW, percent: null }), null);
});

test("band ordering is ok < warn < critical", () => {
  assert.ok(bandRank("ok") < bandRank("warn"));
  assert.ok(bandRank("warn") < bandRank("critical"));
  const t = bandThresholds(usage(0), DEFAULT_BAND_CONFIG);
  assert.ok(t.warn < t.critical);
});

test("crossing helper notifies only on upward crossings", () => {
  assert.equal(shouldNotify("ok", "warn"), true);
  assert.equal(shouldNotify("warn", "warn"), false);
  assert.equal(shouldNotify("warn", "critical"), true);
  assert.equal(shouldNotify("critical", "critical"), false);
  assert.equal(shouldNotify("critical", "warn"), false, "downward is not a crossing");
  assert.equal(shouldNotify("ok", "critical"), true);
  assert.equal(shouldNotify("ok", "ok"), false);
});

test("guidelineFor is null for ok and carries the current pct for warn/critical", () => {
  assert.equal(guidelineFor("ok", usage(150_000)), null);

  const warnUsage = usage(150_000);
  const pct = currentPercent(warnUsage);
  const warn = guidelineFor("warn", warnUsage);
  assert.ok(warn.includes(`~${pct}%`), `warn guideline carries pct ${pct}`);
  assert.match(warn, /begin_transfer/);
  assert.match(warn, /hands-off/);
  assert.match(warn, /update-docs/);
  assert.match(warn, /request_transfer/);

  const criticalUsage = { tokens: 210_000, contextWindow: WINDOW, percent: 80.1 };
  const critical = guidelineFor("critical", criticalUsage);
  assert.ok(critical.includes("~80%"), "critical guideline uses usage.percent");
});

test("percent is taken from usage.percent when present, else computed", () => {
  assert.equal(currentPercent({ tokens: 100, contextWindow: 1000, percent: 37.4 }), 37);
  assert.equal(currentPercent({ tokens: 100, contextWindow: 1000, percent: null }), 10);
});

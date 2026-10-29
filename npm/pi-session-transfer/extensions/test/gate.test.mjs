// Run: node --test test/gate.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GATE_CONFIG,
  DEFAULT_IDLE_MS,
  configFromEnv,
  gateFires,
  thresholdFor,
} from "../core/gate.ts";

const WINDOW = 262144;
const usage = (tokens, contextWindow = WINDOW) => ({ tokens, contextWindow });

test("threshold math on a 262144 window caps at 150K", () => {
  assert.equal(thresholdFor(WINDOW), 150_000);
  assert.equal(thresholdFor(64_000), Math.round(0.7 * 64_000));
});

test("gate needs BOTH a hot session and enough idle time", () => {
  assert.equal(gateFires(usage(200_000), DEFAULT_IDLE_MS, DEFAULT_GATE_CONFIG), true);
  assert.equal(gateFires(usage(200_000), DEFAULT_IDLE_MS - 1, DEFAULT_GATE_CONFIG), false, "not idle enough");
  assert.equal(gateFires(usage(100_000), DEFAULT_IDLE_MS, DEFAULT_GATE_CONFIG), false, "not hot enough");
});

test("fail-silent on unknown usage", () => {
  assert.equal(gateFires(undefined, DEFAULT_IDLE_MS, DEFAULT_GATE_CONFIG), false);
  assert.equal(gateFires({ tokens: null, contextWindow: WINDOW }, DEFAULT_IDLE_MS, DEFAULT_GATE_CONFIG), false);
});

test("disabled config makes the gate a no-op", () => {
  const cfg = { ...DEFAULT_GATE_CONFIG, disabled: true };
  assert.equal(gateFires(usage(250_000), DEFAULT_IDLE_MS * 10, cfg), false);
});

test("env override: token threshold and idle minutes", () => {
  const cfg = configFromEnv({ SESSION_TRANSFER_THRESHOLD_TOKENS: "5000", SESSION_TRANSFER_IDLE_MIN: "1" });
  assert.equal(cfg.thresholdTokens, 5_000);
  assert.equal(cfg.idleMs, 60_000);
  assert.equal(gateFires(usage(5_000, 8_000), 60_000, cfg), true);
  assert.equal(gateFires(usage(4_999, 8_000), 60_000, cfg), false);
});

test("env off-switch", () => {
  assert.equal(configFromEnv({ SESSION_TRANSFER_DISABLE: "1" }).disabled, true);
  assert.equal(configFromEnv({ SESSION_TRANSFER_DISABLE: "true" }).disabled, true);
  assert.equal(configFromEnv({}).disabled, false);
});

test("auto-transfer is off by default; SESSION_TRANSFER_AUTO opts in", () => {
  assert.equal(configFromEnv({}).auto, false);
  assert.equal(configFromEnv({ SESSION_TRANSFER_AUTO: "1" }).auto, true);
  assert.equal(configFromEnv({ SESSION_TRANSFER_AUTO: "true" }).auto, true);
  assert.equal(configFromEnv({ SESSION_TRANSFER_AUTO: "no" }).auto, false);
});

test("bad env values fall back to defaults", () => {
  assert.deepEqual(configFromEnv({ SESSION_TRANSFER_THRESHOLD_TOKENS: "abc" }), DEFAULT_GATE_CONFIG);
  assert.deepEqual(configFromEnv({ SESSION_TRANSFER_IDLE_MIN: "-5" }), DEFAULT_GATE_CONFIG);
  assert.deepEqual(configFromEnv({}), DEFAULT_GATE_CONFIG);
});

// Headless-тесты pure-сеамов yuan extension.
import assert from "node:assert/strict";
import test from "node:test";
import { usdToYuan, patchCostLine } from "../core.ts";

test("usdToYuan(1.499, 6.7) === '10.04' (spec acceptance)", () => {
	assert.equal(usdToYuan(1.499, 6.7), "10.04");
});

test("zero cost", () => {
	assert.equal(usdToYuan(0, 6.7), "0.00");
});

test("negative cost passes through (rounding only)", () => {
	assert.equal(usdToYuan(-1.005, 6.7), "-6.73");
});

test("large cost stays 2 decimals", () => {
	assert.equal(usdToYuan(1234.5678, 6.7), "8271.60");
});

// --- patchCostLine: inline ¥ next to the built-in $ figure ---

const STATS = "↑51k ↓10k R962k CH99.1% $0.271 49k/2bk (18.0%)";

test("patches $X.XXX inline, preserving the rest of the line", () => {
	const out = patchCostLine(STATS, 6.7);
	assert.ok(out.includes("$0.271 ¥1.82"), "got: " + out);
	assert.ok(out.includes("↑51k") && out.includes("(18.0%)"), "rest of line intact");
});

test("ANSI codes around the price are preserved", () => {
	const ansi = "\x1b[2m$0.271\x1b[0m 49k/2bk";
	const out = patchCostLine(ansi, 6.7);
	assert.ok(out.includes("\x1b[2m$0.271 ¥1.82\x1b[0m"), "got: " + JSON.stringify(out));
});

test("subscription marker kept: $0.000 (sub) still patches", () => {
	const out = patchCostLine("$0.000 (sub) 49k/2bk", 6.7);
	assert.ok(out.includes("$0.000 ¥0.00 (sub)"), "got: " + out);
});

test("no $ figure -> line unchanged (pi format change fail-safe)", () => {
	const line = "↑51k 49k/2bk (18.0%)";
	assert.equal(patchCostLine(line, 6.7), line);
});

test("rate formatting: 6.7 vs 6.72 conversion (no rate suffix inline)", () => {
	assert.ok(patchCostLine("$1.000", 6.7).includes("¥6.70"));
	assert.ok(patchCostLine("$1.000", 6.72).includes("¥6.72"));
	assert.ok(!patchCostLine("$1.000", 6.72).includes("rate"), "no rate suffix inline");
});

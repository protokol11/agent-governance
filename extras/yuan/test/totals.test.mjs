// Headless-тесты month/all-time скана и TTL-кэша yuan extension.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	addEntryToTotals,
	costFromEntry,
	cycleSign,
	DEFAULT_JPY_RATE,
	DEFAULT_RATE,
	DEFAULT_SIGNS,
	entryTimestampMs,
	formatAge,
	formatAmount,
	isFresh,
	loadCache,
	loadFooterSettings,
	loadJpyRate,
	loadRate,
	loadSign,
	loadView,
	monthStartTs,
	renderCostBlock,
	saveCache,
	saveJpyRate,
	saveRate,
	saveSign,
	saveViewFlag,
	scanSessionFiles,
	sessionCostUsd,
} from "../core.ts";

const ASSISTANT = (usd, ts) => ({
	type: "message",
	timestamp: ts,
	message: { role: "assistant", usage: { cost: { total: usd } } },
});

// --- monthStartTs ---

test("monthStartTs returns the 1st of the month at local midnight", () => {
	const now = new Date(2026, 9, 3, 23, 59); // 2026-10-03
	assert.equal(monthStartTs(now), new Date(2026, 9, 1).getTime());
});

test("monthStartTs handles January", () => {
	const now = new Date(2027, 0, 15);
	assert.equal(monthStartTs(now), new Date(2027, 0, 1).getTime());
});

// --- costFromEntry ---

test("bills assistant and toolResult message costs", () => {
	assert.equal(costFromEntry(ASSISTANT(1.25, "2026-10-01T00:00:00Z")), 1.25);
	assert.equal(
		costFromEntry({
			type: "message",
			message: { role: "toolResult", usage: { cost: { total: 0.5 } } },
		}),
		0.5,
	);
});

test("toolResult is a subagent passthrough: counted in-memory, excluded in the file scan", () => {
	const tr = {
		type: "message",
		timestamp: "2026-10-02T12:00:00Z",
		message: { role: "toolResult", usage: { cost: { total: 0.5 } } },
	};
	assert.equal(costFromEntry(tr), 0.5);
	assert.equal(costFromEntry(tr, { includeToolResult: false }), 0);
	const m0 = new Date(2026, 9, 1).getTime();
	assert.deepEqual(addEntryToTotals({ monthUsd: 0, allTimeUsd: 0 }, tr, m0, { includeToolResult: false }), {
		monthUsd: 0,
		allTimeUsd: 0,
	});
});

test("bills compaction and branch_summary usage", () => {
	assert.equal(costFromEntry({ type: "compaction", usage: { cost: { total: 0.1 } } }), 0.1);
	assert.equal(costFromEntry({ type: "branch_summary", usage: { cost: { total: 0.2 } } }), 0.2);
});

test("user messages and unrelated records are free", () => {
	assert.equal(costFromEntry({ type: "message", message: { role: "user" } }), 0);
	assert.equal(costFromEntry({ type: "model_change" }), 0);
	// subagent-artifacts transcripts have recordType, not type -> free
	assert.equal(costFromEntry({ recordType: "message", usage: { cost: { total: 9 } } }), 0);
});

// --- entryTimestampMs ---

test("entryTimestampMs parses ISO and tolerates junk", () => {
	assert.equal(entryTimestampMs({ timestamp: "2026-10-02T12:00:00.000Z" }), Date.parse("2026-10-02T12:00:00.000Z"));
	assert.equal(entryTimestampMs({}), null);
	assert.equal(entryTimestampMs({ timestamp: "not-a-date" }), null);
});

// --- addEntryToTotals ---

test("entry inside the month counts toward both buckets", () => {
	const monthStart = Date.parse("2026-10-01T00:00:00Z");
	const acc = addEntryToTotals({ monthUsd: 0, allTimeUsd: 0 }, ASSISTANT(2, "2026-10-02T12:00:00Z"), monthStart);
	assert.deepEqual(acc, { monthUsd: 2, allTimeUsd: 2 });
});

test("entry before the month counts toward all-time only", () => {
	const monthStart = Date.parse("2026-10-01T00:00:00Z");
	const acc = addEntryToTotals({ monthUsd: 0, allTimeUsd: 5 }, ASSISTANT(3, "2026-09-15T12:00:00Z"), monthStart);
	assert.deepEqual(acc, { monthUsd: 0, allTimeUsd: 8 });
});

test("missing timestamp counts toward all-time only (never guessed into month)", () => {
	const monthStart = Date.parse("2026-10-01T00:00:00Z");
	const acc = addEntryToTotals({ monthUsd: 0, allTimeUsd: 0 }, { type: "compaction", usage: { cost: { total: 1 } } }, monthStart);
	assert.deepEqual(acc, { monthUsd: 0, allTimeUsd: 1 });
});

test("zero-cost entry leaves the accumulator untouched", () => {
	const acc = { monthUsd: 1, allTimeUsd: 2 };
	assert.equal(addEntryToTotals(acc, { type: "model_change" }, 0), acc);
});

// --- sessionCostUsd stays a thin wrapper over costFromEntry ---

test("sessionCostUsd sums entries in memory", () => {
	assert.equal(sessionCostUsd([ASSISTANT(1, "2026-10-01T00:00:00Z"), { type: "compaction", usage: { cost: { total: 0.5 } } }]), 1.5);
});

// --- scanSessionFiles over real files ---

test("scanSessionFiles folds month + all-time across files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "yuan-scan-"));
	const a = join(dir, "a.jsonl");
	const b = join(dir, "b.jsonl");
	writeFileSync(
		a,
		[
			'{"type":"session","timestamp":"2026-10-01T00:00:00.000Z"}',
			'{"type":"message","timestamp":"2026-10-02T12:00:00.000Z","message":{"role":"assistant","usage":{"cost":{"total":1.5}}}}',
			'{"type":"message","timestamp":"2026-09-15T12:00:00.000Z","message":{"role":"assistant","usage":{"cost":{"total":2.25}}}}',
		].join("\n") + "\n",
		"utf-8",
	);
	writeFileSync(
		b,
		[
			'{"type":"message","timestamp":"2026-10-02T13:00:00.000Z","message":{"role":"user"}}',
			'{"type":"compaction","timestamp":"2026-10-02T14:00:00.000Z","usage":{"cost":{"total":0.25}}}',
			'{"type":"message","message":{"role":"assistant","usage":{"cost":{"total":0.4}}}}', // no ts -> all-time only
			"not-json",
		].join("\n") + "\n",
		"utf-8",
	);

	const monthStart = new Date(2026, 9, 1).getTime();
	const totals = await scanSessionFiles([a, b], monthStart);
	assert.equal(totals.monthUsd, 1.75); // 1.5 + 0.25
	assert.equal(totals.allTimeUsd, 4.4); // + 2.25 + 0.4
});

test("scanSessionFiles does not double-bill a subagent passthrough (regression)", async () => {
	// Real layout: parent journal sits next to <hash>/run-0/session.jsonl, and the
	// parent's toolResult total equals the child journal total exactly.
	const dir = mkdtempSync(join(tmpdir(), "yuan-sub-"));
	const parent = join(dir, "parent.jsonl");
	const childDir = join(dir, "abc123", "run-0");
	mkdirSync(childDir, { recursive: true });
	const child = join(childDir, "session.jsonl");

	writeFileSync(
		parent,
		[
			'{"type":"session","timestamp":"2026-10-01T00:00:00.000Z"}',
			'{"type":"message","timestamp":"2026-10-02T10:00:00.000Z","message":{"role":"assistant","usage":{"cost":{"total":1.0}}}}',
			// passthrough of the child run — must NOT be added on top of the child journal
			'{"type":"message","timestamp":"2026-10-02T11:00:00.000Z","message":{"role":"toolResult","usage":{"cost":{"total":0.5}}}}',
		].join("\n") + "\n",
		"utf-8",
	);
	writeFileSync(
		child,
		'{"type":"message","timestamp":"2026-10-02T11:00:00.000Z","message":{"role":"assistant","usage":{"cost":{"total":0.5}}}}\n',
		"utf-8",
	);

	const totals = await scanSessionFiles([parent, child], new Date(2026, 9, 1).getTime());
	assert.equal(totals.allTimeUsd, 1.5); // parent 1.0 + child 0.5, passthrough ignored
	assert.equal(totals.monthUsd, 1.5);
});

test("scanSessionFiles survives missing files", async () => {
	const totals = await scanSessionFiles([join(tmpdir(), "does-not-exist-yuan.jsonl")], 0);
	assert.deepEqual(totals, { monthUsd: 0, allTimeUsd: 0 });
});

// --- cache + TTL ---

test("saveCache/loadCache roundtrip and reject malformed cache", () => {
	const dir = mkdtempSync(join(tmpdir(), "yuan-cache-"));
	const path = join(dir, "cache.json");
	saveCache({ monthUsd: 12.5, allTimeUsd: 800.25 }, 1000, path);
	const loaded = loadCache(path);
	assert.deepEqual(loaded, { monthUsd: 12.5, allTimeUsd: 800.25, computedAt: 1000 });

	writeFileSync(path, "{ not json", "utf-8");
	assert.equal(loadCache(path), null);
});

test("loadCache returns null when the file is absent", () => {
	assert.equal(loadCache(join(tmpdir(), "yuan-absent-cache.json")), null);
});

test("isFresh honours TTL and rejects future timestamps", () => {
	const cache = { monthUsd: 0, allTimeUsd: 0, computedAt: 1000 };
	assert.equal(isFresh(cache, 1000, 600000), true);
	assert.equal(isFresh(cache, 1000 + 599999, 600000), true);
	assert.equal(isFresh(cache, 1000 + 600000, 600000), false);
	assert.equal(isFresh(cache, 999, 600000), false); // clock went backwards
});

test("formatAge renders compact ages", () => {
	assert.equal(formatAge(0, 30_000), "just now");
	assert.equal(formatAge(0, 7 * 60_000), "7m");
	assert.equal(formatAge(0, 2 * 3600_000), "2h");
	assert.equal(formatAge(0, 3 * 86_400_000), "3d");
});

// --- multi-currency formatting ---

const RATES = { cny: 6.71, jpy: 157.8 };

test("formatAmount disambiguates CN¥ / JP¥ / $", () => {
	assert.equal(formatAmount(2, "cny", RATES), "CN¥13.42");
	assert.equal(formatAmount(2, "jpy", RATES), "JP¥315.60");
	assert.equal(formatAmount(2, "usd", RATES), "$2.00");
});

test("formatAmount zero", () => {
	assert.equal(formatAmount(0, "cny", RATES), "CN¥0.00");
	assert.equal(formatAmount(0, "jpy", RATES), "JP¥0.00");
	assert.equal(formatAmount(0, "usd", RATES), "$0.00");
});

// --- config: two independent rates ---

test("set rate writes only the CNY key and preserves JPY", () => {
	const path = join(mkdtempSync(join(tmpdir(), "yuan-cfg-")), "config.json");
	saveJpyRate(150, path);
	assert.equal(loadJpyRate(path), 150);
	assert.equal(loadRate(path), DEFAULT_RATE); // missing CNY -> default

	saveRate(6.5, path);
	assert.equal(loadRate(path), 6.5);
	assert.equal(loadJpyRate(path), 150); // untouched
});

test("set yen writes only the JPY key and preserves CNY", () => {
	const path = join(mkdtempSync(join(tmpdir(), "yuan-cfg-")), "config.json");
	saveRate(6.9, path);
	saveJpyRate(160, path);
	assert.equal(loadRate(path), 6.9);
	assert.equal(loadJpyRate(path), 160);
});

test("missing config falls back to defaults", () => {
	const path = join(tmpdir(), "yuan-absent-config.json");
	assert.equal(loadRate(path), DEFAULT_RATE);
	assert.equal(loadJpyRate(path), DEFAULT_JPY_RATE);
});

// --- footer cost block (what ctx262 renders) ---

const VIEWS_ALL = { usd: { session: true, month: true, all: true }, cny: { session: true, month: true, all: true }, jpy: { session: true, month: true, all: true } };
const TOTALS = { monthUsd: 10, allTimeUsd: 100 };

test("renderCostBlock: session for all three currencies by default layout", () => {
	const s = renderCostBlock(1, TOTALS, RATES, {
		usd: { session: true, month: false, all: false },
		cny: { session: true, month: false, all: false },
		jpy: { session: true, month: false, all: false },
	});
	assert.equal(s, "$1.00 CN¥6.71 JP¥157.80");
});

test("renderCostBlock: month -> <fig>/m and all -> <fig>/all, symbol repeated", () => {
	const s = renderCostBlock(1, TOTALS, RATES, {
		usd: { session: false, month: false, all: false },
		cny: { session: true, month: true, all: true },
		jpy: { session: false, month: false, all: false },
	});
	assert.equal(s, "CN¥6.71 CN¥67.10/m CN¥671.00/all");
});

test("renderCostBlock honours sign overrides", () => {
	const signOf = { cny: "¥", jpy: "¥", usd: "$" };
	const s = renderCostBlock(1, TOTALS, RATES, {
		usd: { session: false, month: false, all: false },
		cny: { session: true, month: true, all: true },
		jpy: { session: false, month: false, all: false },
	}, signOf);
	assert.equal(s, "¥6.71 ¥67.10/m ¥671.00/all");
});

test("renderCostBlock: hiding /usd session drops the $ figure", () => {
	const s = renderCostBlock(1, TOTALS, RATES, {
		usd: { session: false, month: false, all: false },
		cny: { session: true, month: false, all: false },
		jpy: { session: false, month: false, all: false },
	});
	assert.equal(s, "CN¥6.71");
});

test("renderCostBlock: no cache -> month / all silently omitted", () => {
	const s = renderCostBlock(1, null, RATES, VIEWS_ALL);
	assert.equal(s, "$1.00 CN¥6.71 JP¥157.80");
});

test("renderCostBlock: everything hidden renders empty (no stray separators)", () => {
	const off = { session: false, month: false, all: false };
	assert.equal(renderCostBlock(1, TOTALS, RATES, { usd: off, cny: off, jpy: off }), "");
});

test("loadFooterSettings reads rates and all three views in one config read", () => {
	const path = freshCfg();
	saveRate(6.5, path);
	saveJpyRate(150, path);
	saveViewFlag("usd", "session", false, path);
	saveViewFlag("yen", "all", false, path);
	saveSign("yuan", "¥", path);
	const { rates, views, signs } = loadFooterSettings(path);
	assert.deepEqual(rates, { cny: 6.5, jpy: 150 });
	assert.deepEqual(views.usd, { session: false, month: true, all: true });
	assert.deepEqual(views.jpy, { session: true, month: true, all: false });
	assert.deepEqual(views.cny, { session: true, month: true, all: true });
	assert.deepEqual(signs, { cny: "¥", jpy: "JP¥", usd: "$" });
});

// --- sign override / change sign ---

test("loadSign defaults to the disambiguated signs", () => {
	const path = freshCfg();
	assert.equal(loadSign("yuan", path), "CN¥");
	assert.equal(loadSign("yen", path), "JP¥");
	assert.equal(loadSign("usd", path), "$");
});

test("cycleSign flips CN¥ -> ¥ -> CN¥ (and leaves other commands alone)", () => {
	const path = freshCfg();
	assert.equal(cycleSign("yuan", path), "¥");
	assert.equal(loadSign("yuan", path), "¥");
	assert.equal(cycleSign("yuan", path), "CN¥");
	assert.equal(loadSign("yen", path), "JP¥"); // untouched
});

test("cycleSign on yen and usd", () => {
	const path = freshCfg();
	assert.equal(cycleSign("yen", path), "¥");
	assert.equal(cycleSign("yen", path), "JP¥");
	assert.equal(cycleSign("usd", path), "USD");
	assert.equal(cycleSign("usd", path), "$");
});

test("saveSign sets an explicit sign and survives rate/view writes", () => {
	const path = freshCfg();
	saveSign("yuan", "元", path);
	saveRate(6.9, path);
	saveViewFlag("usd", "session", false, path);
	assert.equal(loadSign("yuan", path), "元");
	assert.equal(loadRate(path), 6.9);
});

// --- per-command view flags ---

const freshCfg = () => join(mkdtempSync(join(tmpdir(), "yuan-view-")), "config.json");

test("loadView defaults to all three visible (footer layout keys default is all-on)", () => {
	assert.deepEqual(loadView("usd", freshCfg()), { session: true, month: true, all: true });
});

test("saveViewFlag hides one figure and leaves the others visible", () => {
	const path = freshCfg();
	const next = saveViewFlag("usd", "session", false, path);
	assert.deepEqual(next, { session: false, month: true, all: true });
	assert.deepEqual(loadView("usd", path), { session: false, month: true, all: true });
});

test("view flags are independent per command", () => {
	const path = freshCfg();
	saveViewFlag("usd", "session", false, path);
	saveViewFlag("yen", "all", false, path);
	assert.deepEqual(loadView("usd", path), { session: false, month: true, all: true });
	assert.deepEqual(loadView("yen", path), { session: true, month: true, all: false });
	assert.deepEqual(loadView("yuan", path), { session: true, month: true, all: true });
});

test("view toggles do not clobber rates and vice versa", () => {
	const path = freshCfg();
	saveRate(6.9, path);
	saveJpyRate(160, path);
	saveViewFlag("usd", "month", false, path);
	assert.equal(loadRate(path), 6.9);
	assert.equal(loadJpyRate(path), 160);
	saveRate(7.0, path);
	assert.deepEqual(loadView("usd", path), { session: true, month: false, all: true });
});

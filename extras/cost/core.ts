// Pure core of the yuan extension — no pi imports, headless-testable.
// (same pattern as setup-upgrade: core.ts + index.ts)
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import readline from "node:readline";

export const DEFAULT_RATE = 6.7; // CNY per USD
export const DEFAULT_JPY_RATE = 157.8; // JPY per USD
export const CONFIG_PATH = join(import.meta.dirname, "config.json");
export const CACHE_PATH = join(import.meta.dirname, "cache.json");
export const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
export const CACHE_TTL_MS = 10 * 60 * 1000;

type UsageLike = { cost?: { total?: number } };

/** Single pure seam for conversion + formatting. */
export function usdToYuan(costUsd: number, rate: number): string {
	return (costUsd * rate).toFixed(2);
}

export type Currency = "cny" | "jpy" | "usd";

export type Rates = { cny: number; jpy: number };

/** Default signs. CNY and JPY both use ¥, so they ship disambiguated as CN¥ / JP¥. */
export const DEFAULT_SIGNS: Record<Currency, string> = { cny: "CN¥", jpy: "JP¥", usd: "$" };

/**
 * Format a USD amount in the requested currency, prefixed by `sign`
 * (defaults to the disambiguated CN¥ / JP¥ / $). 2 decimals everywhere.
 */
export function formatAmount(
	costUsd: number,
	currency: Currency,
	rates: Rates,
	sign = DEFAULT_SIGNS[currency],
): string {
	const num = currency === "usd" ? costUsd.toFixed(2) : usdToYuan(costUsd, rates[currency]);
	return `${sign}${num}`;
}

// --- sign overrides (`/<cmd> change sign [sign]`) ---

/** Command name -> the two forms its sign cycles between (glyph first). */
export const SIGN_FORMS: Record<string, [string, string]> = {
	yuan: ["¥", "CN¥"],
	yen: ["¥", "JP¥"],
	usd: ["$", "USD"],
};

const DEFAULT_SIGN_BY_CMD: Record<string, string> = { yuan: "CN¥", yen: "JP¥", usd: "$" };

/** Current sign for one command; empty / missing falls back to the default. */
export function loadSign(cmd: string, path = CONFIG_PATH): string {
	const stored = asObject(readConfig(path).signs)[cmd];
	return typeof stored === "string" && stored.length > 0 ? stored : DEFAULT_SIGN_BY_CMD[cmd];
}

export function saveSign(cmd: string, sign: string, path = CONFIG_PATH): void {
	const signs = { ...asObject(readConfig(path).signs), [cmd]: sign };
	patchConfig({ signs }, path);
}

/**
 * No-argument `/<cmd> change sign`: flip between the command's two forms.
 * From the default (long) form the first press lands on the plain glyph.
 */
export function cycleSign(cmd: string, path = CONFIG_PATH): string {
	const forms = SIGN_FORMS[cmd];
	if (!forms) return DEFAULT_SIGN_BY_CMD[cmd] ?? "";
	const cur = loadSign(cmd, path);
	const idx = forms.indexOf(cur);
	const next = idx === -1 ? forms[0] : forms[(idx + 1) % forms.length];
	saveSign(cmd, next, path);
	return next;
}

/**
 * Pure seam: patch a rendered footer stats line, appending ¥ after the first
 * `$X.XXX` occurrence. ANSI codes around the price are preserved (the match is
 * on the plain-text core). No match -> line unchanged (fail-safe).
 * User asked to keep it compact: no "(rate …)" suffix inline (rate is shown
 * by `/yuan` instead).
 */
export function patchCostLine(line: string, rate: number): string {
	return line.replace(/\$([0-9]+\.[0-9]{3})/, (match, usd: string) => {
		return `${match} ¥${usdToYuan(parseFloat(usd), rate)}`;
	});
}

type ConfigLike = { rate?: unknown; jpy?: unknown; view?: unknown; signs?: unknown };

const validRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const asObject = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function readConfig(path = CONFIG_PATH): ConfigLike {
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as ConfigLike;
	} catch {
		// unreadable / malformed config — treat as empty
	}
	return {};
}

type FullConfig = {
	rate: number;
	jpy: number;
	view: Record<string, unknown>;
	signs: Record<string, unknown>;
};

/**
 * The single writer. Every setter goes through it, so a set/change in one
 * section never drops the other keys (rates / view / signs).
 */
function patchConfig(patch: Partial<FullConfig>, path = CONFIG_PATH): FullConfig {
	const cur = readConfig(path);
	const next: FullConfig = {
		rate: patch.rate ?? (validRate(cur.rate) ? cur.rate : DEFAULT_RATE),
		jpy: patch.jpy ?? (validRate(cur.jpy) ? cur.jpy : DEFAULT_JPY_RATE),
		view: patch.view ?? asObject(cur.view),
		signs: patch.signs ?? asObject(cur.signs),
	};
	writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
	return next;
}

export function loadRate(path = CONFIG_PATH): number {
	const rate = readConfig(path).rate;
	return validRate(rate) ? rate : DEFAULT_RATE;
}

/**
 * `/yuan set <rate>` — updates only the CNY key; JPY / view / signs survive.
 * (ctx262.ts imports loadRate for the footer; its shape stays `rate`.)
 */
export function saveRate(rate: number, path = CONFIG_PATH): void {
	patchConfig({ rate }, path);
}

export function loadJpyRate(path = CONFIG_PATH): number {
	const jpy = readConfig(path).jpy;
	return validRate(jpy) ? jpy : DEFAULT_JPY_RATE;
}

/** `/yen set <rate>` — updates only the JPY key; CNY / view / signs survive. */
export function saveJpyRate(jpy: number, path = CONFIG_PATH): void {
	patchConfig({ jpy }, path);
}

// --- per-command view flags (which of session / month / all to render) ---

export type ViewKey = "session" | "month" | "all";
export type ViewFlags = Record<ViewKey, boolean>;

export const DEFAULT_VIEW: ViewFlags = { session: true, month: true, all: true };
export const VIEW_KEYS: ViewKey[] = ["session", "month", "all"];

/** Merge a raw stored object over the defaults. */
function mergeView(stored: unknown): ViewFlags {
	const raw = asObject(stored);
	const out: ViewFlags = { ...DEFAULT_VIEW };
	for (const k of VIEW_KEYS) {
		if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
	}
	return out;
}

/** Stored flags for one command (`yuan` / `yen` / `usd`), merged over defaults. */
export function loadView(cmd: string, path = CONFIG_PATH): ViewFlags {
	return mergeView(asObject(readConfig(path).view)[cmd]);
}

/** Footer settings in one config read: rates + the three command views + signs. */
export function loadFooterSettings(path = CONFIG_PATH): {
	rates: Rates;
	views: { usd: ViewFlags; cny: ViewFlags; jpy: ViewFlags };
	signs: Record<Currency, string>;
} {
	const cfg = readConfig(path);
	const view = asObject(cfg.view);
	const sign = asObject(cfg.signs);
	const one = (cmd: string, fallback: string): string => {
		const v = sign[cmd];
		return typeof v === "string" && v.length > 0 ? v : fallback;
	};
	return {
		rates: {
			cny: validRate(cfg.rate) ? cfg.rate : DEFAULT_RATE,
			jpy: validRate(cfg.jpy) ? cfg.jpy : DEFAULT_JPY_RATE,
		},
		views: {
			usd: mergeView(view.usd),
			cny: mergeView(view.yuan),
			jpy: mergeView(view.yen),
		},
		signs: {
			usd: one("usd", DEFAULT_SIGNS.usd),
			cny: one("yuan", DEFAULT_SIGNS.cny),
			jpy: one("yen", DEFAULT_SIGNS.jpy),
		},
	};
}

/**
 * Footer cost block: for every currency whose flags are on, render its enabled
 * figures inline. Session is the live value; month / all-time come from the
 * scan cache (null -> omitted, e.g. before the first command ever ran).
 *
 *   renderCostBlock(0.165, cache, rates, views) -> "$0.165 CN¥1.11 JP¥22.36"
 *   with yen month+all on -> "... JP¥22.36 JP¥5693.68/m JP¥127092.51/all"
 *
 * month / all-time use the compact /m and /all suffixes (the word "month" is
 * gone); the sign is repeated on each figure per user request.
 */
export function renderCostBlock(
	sessionUsd: number,
	totals: Totals | null,
	rates: Rates,
	views: { usd: ViewFlags; cny: ViewFlags; jpy: ViewFlags },
	signs: Record<Currency, string> = DEFAULT_SIGNS,
): string {
	const chunks: string[] = [];
	const add = (currency: Currency, flags: ViewFlags) => {
		const sign = signs[currency];
		const figs: string[] = [];
		if (flags.session) figs.push(formatAmount(sessionUsd, currency, rates, sign));
		if (flags.month && totals) figs.push(`${formatAmount(totals.monthUsd, currency, rates, sign)}/m`);
		if (flags.all && totals) figs.push(`${formatAmount(totals.allTimeUsd, currency, rates, sign)}/all`);
		if (figs.length) chunks.push(figs.join(" "));
	};
	add("usd", views.usd);
	add("cny", views.cny);
	add("jpy", views.jpy);
	return chunks.join(" ");
}

/** Toggle one flag for one command; other commands and keys are untouched. */
export function saveViewFlag(cmd: string, key: ViewKey, value: boolean, path = CONFIG_PATH): ViewFlags {
	const view = { ...asObject(readConfig(path).view) };
	const next: ViewFlags = { ...loadView(cmd, path), [key]: value };
	view[cmd] = next;
	patchConfig({ view }, path);
	return next;
}

type EntryLike = { type?: string; usage?: UsageLike; message?: { role?: string; usage?: UsageLike }; timestamp?: string };

export type CostOptions = {
	/**
	 * Whether a `toolResult` message's usage counts. Default true.
	 *
	 * A subagent's total cost is written twice: once as the subagent's own
	 * assistant entries in its own `run-N/session.jsonl`, and once as a
	 * passthrough `toolResult` in the parent journal (verified: the parent's
	 * toolResult total equals the child journal total exactly).
	 *
	 *  - in-memory current session (footer): keep true — the child journals are
	 *    not part of this session's entry list, so the passthrough is the only
	 *    place the subagent spend appears.
	 *  - all-time / month file scan: set false — every subagent has its own
	 *    journal on disk, so counting the passthrough too would double-bill.
	 */
	includeToolResult?: boolean;
};

/**
 * Cost of a single session-journal entry, or 0 when the entry carries none.
 * Mirrors the roles pi bills for: assistant + toolResult messages, plus the
 * compaction / branch_summary summaries. Any other record type is free.
 */
export function costFromEntry(e: unknown, opts: CostOptions = {}): number {
	const includeToolResult = opts.includeToolResult ?? true;
	const entry = e as EntryLike;
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return entry.usage?.cost?.total ?? 0;
	}
	if (entry.type !== "message") return 0;
	const m = entry.message;
	if (!m) return 0;
	if (m.role === "assistant") return m.usage?.cost?.total ?? 0;
	if (m.role === "toolResult") return includeToolResult ? (m.usage?.cost?.total ?? 0) : 0;
	return 0;
}

/** Cumulative session USD cost: assistant messages + tool-result nested usage + summaries. */
export function sessionCostUsd(entries: unknown[]): number {
	let cost = 0;
	for (const e of entries) cost += costFromEntry(e);
	return cost;
}

/** Epoch ms of the first instant of the calendar month containing `now` (local time). */
export function monthStartTs(now: Date): number {
	return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** Epoch ms of an entry's `timestamp` field, or null when missing/unparseable. */
export function entryTimestampMs(e: unknown): number | null {
	const ts = (e as EntryLike).timestamp;
	if (typeof ts !== "string") return null;
	const ms = Date.parse(ts);
	return Number.isFinite(ms) ? ms : null;
}

export type Totals = { monthUsd: number; allTimeUsd: number };

/**
 * Pure fold: add one journal entry into running totals. `monthStart` is the
 * epoch-ms boundary; entries with a missing timestamp count toward all-time
 * only (never fabricated into the month bucket).
 */
export function addEntryToTotals(acc: Totals, e: unknown, monthStart: number, opts: CostOptions = {}): Totals {
	const cost = costFromEntry(e, opts);
	if (cost === 0) return acc;
	const ts = entryTimestampMs(e);
	return {
		monthUsd: ts !== null && ts >= monthStart ? acc.monthUsd + cost : acc.monthUsd,
		allTimeUsd: acc.allTimeUsd + cost,
	};
}

/** Recursively collect every session journal under `root`. */
export function collectSessionFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable dir — skip, never throw
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) out.push(p);
		}
	};
	walk(root);
	return out;
}

/**
 * Scan journals and fold into { monthUsd, allTimeUsd }. Lines without a
 * `"cost"` token are skipped before JSON.parse (the 839 MB tree is mostly
 * prompt text). Unreadable/malformed lines are ignored, never fatal.
 *
 * Subagent `toolResult` passthrough is excluded: each subagent owns a
 * `run-N/session.jsonl` in the same tree, so counting both would double-bill.
 */
export async function scanSessionFiles(files: string[], monthStart: number): Promise<Totals> {
	let acc: Totals = { monthUsd: 0, allTimeUsd: 0 };
	for (const f of files) {
		let rl;
		try {
			rl = readline.createInterface({ input: createReadStream(f), crlfDelay: Infinity });
		} catch {
			continue;
		}
		try {
			for await (const line of rl) {
				if (!line.includes('"cost"')) continue;
				try {
					// includeToolResult:false — the parent's subagent passthrough would
					// double-bill the child journal that sits next to it on disk.
					acc = addEntryToTotals(acc, JSON.parse(line), monthStart, { includeToolResult: false });
				} catch {
					// partial line (live session being appended) — skip
				}
			}
		} catch {
			// file vanished mid-scan — skip
		}
	}
	return acc;
}

export type CostCache = { monthUsd: number; allTimeUsd: number; computedAt: number };

/** Read the cached totals, or null when absent/malformed/rejected. */
export function loadCache(path = CACHE_PATH): CostCache | null {
	try {
		if (!existsSync(path)) return null;
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CostCache>;
		if (
			typeof raw.monthUsd === "number" &&
			typeof raw.allTimeUsd === "number" &&
			typeof raw.computedAt === "number" &&
			Number.isFinite(raw.monthUsd + raw.allTimeUsd + raw.computedAt)
		) {
			return raw as CostCache;
		}
	} catch {
		// malformed cache — treat as absent
	}
	return null;
}

export function saveCache(totals: Totals, nowMs: number, path = CACHE_PATH): void {
	const cache: CostCache = { ...totals, computedAt: nowMs };
	writeFileSync(path, JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

/** Fresh iff computedAt is in the past and within ttl. */
export function isFresh(cache: CostCache, nowMs: number, ttlMs = CACHE_TTL_MS): boolean {
	const age = nowMs - cache.computedAt;
	return age >= 0 && age < ttlMs;
}

/** Human age of a cache entry: "just now", "7m", "2h", "3d". */
export function formatAge(computedAt: number, nowMs: number): string {
	const sec = Math.max(0, Math.floor((nowMs - computedAt) / 1000));
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

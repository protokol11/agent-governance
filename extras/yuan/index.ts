import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
	collectSessionFiles,
	CONFIG_PATH,
	cycleSign,
	DEFAULT_RATE,
	DEFAULT_SIGNS,
	formatAge,
	formatAmount,
	isFresh,
	loadCache,
	loadJpyRate,
	loadRate,
	loadSign,
	loadView,
	monthStartTs,
	SESSIONS_ROOT,
	saveCache,
	saveJpyRate,
	saveRate,
	saveSign,
	saveViewFlag,
	scanSessionFiles,
	sessionCostUsd,
	VIEW_KEYS,
} from "./core.ts";
import type { Currency, ViewKey } from "./core.ts";

/**
 * yuan — multi-currency cost readout: CNY (`/yuan`), JPY (`/yen`), USD (`/usd`).
 *
 * The footer itself is owned by ctx262.ts (this extension never calls
 * ctx.ui.setFooter — two extensions doing that conflict, last-one-wins,
 * learned live 2026-09-14). ctx262 imports renderCostBlock/loadFooterSettings
 * from ./yuan/core.ts and renders the multi-currency cost block, which reads
 * the view flags and signs written by these commands.
 *
 * Principles:
 *  - HUMAN-JUDGMENT-FINAL: rates are user-set via /yuan set, /yen set, or
 *    config.json; no fetch, no auto-update.
 *  - FOG-OF-WAR: each command shows its stored rate and the cache age, so the
 *    all-time / month figures are never mistaken for live numbers. The cache
 *    path is intentionally NOT shown (it is an internal detail).
 *  - NO-BLOCKING-RENDER: the ~5 s scan of ~/.pi/agent/sessions runs only on a
 *    command, behind a TTL cache shared by all three currencies (the cache
 *    stores USD totals, currency-agnostic). The footer only reads that cache.
 */

type Spec = {
	cmd: string;
	currency: Currency;
	unit: string;
	setKey?: "cny" | "jpy";
};

const SPECS: Spec[] = [
	{ cmd: "yuan", currency: "cny", unit: "CNY (CN¥)", setKey: "cny" },
	{ cmd: "yen", currency: "jpy", unit: "JPY (JP¥)", setKey: "jpy" },
	{ cmd: "usd", currency: "usd", unit: "USD ($)" },
];

const isViewKey = (s: string): s is ViewKey => (VIEW_KEYS as string[]).includes(s);

export default function (pi: ExtensionAPI) {
	// Config materializes on first run (spec: config.json created if absent).
	if (!existsSync(CONFIG_PATH)) saveRate(DEFAULT_RATE);

	for (const spec of SPECS) {
		const setHint = spec.setKey ? `; /${spec.cmd} set <rate>` : "";
		const usage =
			`usage: /${spec.cmd}${setHint} | ` +
			`/${spec.cmd} session|month|all view|hide | ` +
			`/${spec.cmd} change sign [sign|reset] | ` +
			`/${spec.cmd} fresh`;
		pi.registerCommand(spec.cmd, {
			description:
				`Show session / month / all-time cost in ${spec.unit}${setHint}; ` +
				`/${spec.cmd} <session|month|all> view|hide toggles each footer figure; ` +
				`/${spec.cmd} change sign [sign] changes the sign; ` +
				`/${spec.cmd} fresh forces a rescan`,
			handler: async (args, ctx) => {
				const argv = args.trim().split(/\s+/).filter(Boolean);

				if (argv[0] === "set") {
					if (!spec.setKey) {
						ctx.ui.notify(`/${spec.cmd}: USD is the base currency — nothing to set`, "warning");
						return;
					}
					const rate = Number(argv[1]);
					if (argv.length !== 2 || !Number.isFinite(rate) || rate <= 0) {
						ctx.ui.notify(
							`usage: /${spec.cmd} set <rate> (positive number, e.g. ${spec.setKey === "cny" ? "6.72" : "157.8"})`,
							"warning",
						);
						return;
					}
					if (spec.setKey === "cny") saveRate(rate);
					else saveJpyRate(rate);
					ctx.ui.notify(`/${spec.cmd}: rate set to ${rate.toFixed(2)} (config.json)`, "info");
					return;
				}

				// /<cmd> <session|month|all> view|hide
				if (argv.length === 2 && isViewKey(argv[0]) && (argv[1] === "view" || argv[1] === "hide")) {
					const value = argv[1] === "view";
					saveViewFlag(spec.cmd, argv[0], value);
					ctx.ui.notify(`/${spec.cmd}: ${argv[0]} ${value ? "shown" : "hidden"} (config.json)`, "info");
					return;
				}

				// /<cmd> change sign [sign|reset] — no argument cycles glyph <-> ISO.
				if (argv[0] === "change" && argv[1] === "sign" && argv.length <= 3) {
					const explicit = argv[2];
					let sign: string;
					if (explicit === "reset") {
						sign = DEFAULT_SIGNS[spec.currency];
						saveSign(spec.cmd, sign);
					} else if (explicit) {
						sign = explicit;
						saveSign(spec.cmd, sign);
					} else {
						sign = cycleSign(spec.cmd);
					}
					ctx.ui.notify(`/${spec.cmd}: sign is now "${sign}" (config.json)`, "info");
					return;
				}

				const force = argv[0] === "fresh";
				if (argv.length > 0 && !force) {
					ctx.ui.notify(usage, "warning");
					return;
				}

				const nowMs = Date.now();
				let cache = loadCache();
				if (force || !cache || !isFresh(cache, nowMs)) {
					ctx.ui.notify(`${spec.cmd}: scanning session history…`, "info");
					const files = collectSessionFiles(SESSIONS_ROOT);
					const totals = await scanSessionFiles(files, monthStartTs(new Date(nowMs)));
					saveCache(totals, nowMs);
					cache = { ...totals, computedAt: nowMs };
				}

				const rates = { cny: loadRate(), jpy: loadJpyRate() };
				const sign = loadSign(spec.cmd);
				const view = loadView(spec.cmd);
				const parts: string[] = [];
				if (view.session) {
					parts.push(`session ${formatAmount(sessionCostUsd(ctx.sessionManager.getEntries()), spec.currency, rates, sign)}`);
				}
				if (view.month) parts.push(`month ${formatAmount(cache.monthUsd, spec.currency, rates, sign)}`);
				if (view.all) parts.push(`all-time ${formatAmount(cache.allTimeUsd, spec.currency, rates, sign)}`);

				if (parts.length === 0) {
					ctx.ui.notify(
						`/${spec.cmd}: all figures hidden — /${spec.cmd} session view | month view | all view`,
						"warning",
					);
					return;
				}

				const age = force ? "fresh" : formatAge(cache.computedAt, nowMs);
				const rateInfo = spec.setKey
					? `rate ${(spec.setKey === "cny" ? rates.cny : rates.jpy).toFixed(2)}, `
					: "";
				ctx.ui.notify(`${parts.join(" · ")} (${rateInfo}${age})`, "info");
			},
		});
	}
}

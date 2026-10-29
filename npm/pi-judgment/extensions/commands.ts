// commands.ts — thin wiring for the /judgments command. No logic: read ledger,
// hand state to the pure renderer, map keys to state transitions. The state
// builder and the y/n decision live in pure modules (explorer-state.ts,
// core/resolve-plan.ts) so `node --test` can drive them without the pi UI layer.
// Prior art: session-manager/commands.ts (ctx.ui.custom + keyDispatch, V008).
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { appendResolution, readJudgments } from "./core/ledger.ts";
import { judgmentStats, nextProvenance } from "./core/stats.ts";
import { planResolution } from "./core/resolve-plan.ts";
import { nextGroup, openingGroup, toExplorerState, type ExplorerViewState } from "./explorer-state.ts";
import { bodyFor, renderJudgments } from "./explorer.ts";

type ViewState = ExplorerViewState;

function applyTheme(theme: Theme, s: { text: string; color?: string }): string {
  if (!s.color || s.color === "default") return s.text;
  return theme.fg(s.color as Parameters<Theme["fg"]>[0], s.text);
}

export function registerJudgmentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("judgments", {
    description: "Full-screen explorer over the judgment ledger: calibration, browse, resolve",
    handler: async (_args, ctx) => {
      const ledgerPath = join(ctx.cwd, CONFIG_DIR_NAME, "judgments.jsonl");
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        const stats = judgmentStats(readJudgments(ledgerPath));
        ctx.ui.notify(
          `judgments: ${stats.total} records, ${stats.resolved} resolved, ${stats.pending} pending (open in TUI for the explorer)`,
          "info"
        );
        return;
      }

      const v: ViewState = {
        view: "ledger",
        modelFilter: null,
        provenanceFilter: "judge",
        pendingOnly: true,
        questionGroup: null, // null = open on openingGroup(); `g` fills it in
        selected: 0,
        message: null,
        help: false,
        height: 24,
        records: readJudgments(ledgerPath),
      };

      await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => ({
          render(width: number): string[] {
            // Reserve two columns for the side borders and two rows for the top
            // and bottom borders, so the box stays inside the overlay bounds.
            const rows = Math.max(10, Math.floor(tui.terminal.rows * 0.85));
            const height = Math.max(8, rows - 3);
            v.height = height; // paging matches the window the renderer just laid out
            const inner = Math.max(1, width - 2);
            const frame = (s: string) => theme.fg("border", s);
            const body = renderJudgments({ ...toExplorerState(v, height, width) }).map((line) =>
              line.map((s) => applyTheme(theme, s)).join("")
            );
            const out: string[] = [frame(`╭${"─".repeat(inner)}╮`)];
            for (const line of body) {
              const clipped = truncateToWidth(line, inner, "");
              out.push(frame("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + frame("│"));
            }
            out.push(frame(`╰${"─".repeat(inner)}╯`));
            return out;
          },
        invalidate() {},
        handleInput(data: string) {
          v.message = null;
          if (matchesKey(data, Key.escape) || data === "q") {
            done(null);
            return;
          }
          const state = toExplorerState(v, v.height, 0);
          const last = Math.max(0, state.rows.length - 1);
          const clamp = (n: number) => Math.max(0, Math.min(last, n));
          if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            v.selected = clamp(v.selected + (matchesKey(data, Key.up) ? -1 : 1));
          } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
            const page = bodyFor(v.height);
            v.selected = clamp(v.selected + (matchesKey(data, Key.pageUp) ? -page : page));
          } else if (matchesKey(data, Key.home)) {
            v.selected = 0;
          } else if (matchesKey(data, Key.end)) {
            v.selected = last;
          } else if (data === "\t") {
            v.view = v.view === "ledger" ? "calibration" : "ledger";
          } else if (matchesKey(data, Key.question)) {
            v.help = !v.help;
          } else if (data === "f") {
            v.pendingOnly = !v.pendingOnly;
            v.selected = 0;
          } else if (data === "m") {
            const models = judgmentStats(v.records).models;
            const i = v.modelFilter ? models.indexOf(v.modelFilter) : -1;
            v.modelFilter = i + 1 < models.length ? models[i + 1] : null;
            v.selected = 0;
          } else if (data === "p") {
            // Cycle the provenances the ledger actually holds, so `code` and
            // `classifier` rows are reachable; the curve stays one family at a
            // time (mixed provenances would blur it).
            v.provenanceFilter = nextProvenance(
              v.records.map((r) => r.provenance),
              v.provenanceFilter
            );
            v.selected = 0;
          } else if (data === "g") {
            // Cycle only the groups the current model + provenance filter leaves,
            // so `g` never lands on a pane that would render another filter's rows.
            const current = v.questionGroup ?? openingGroup(v.records, v.modelFilter, v.provenanceFilter);
            v.questionGroup = nextGroup(v.records, current, v.modelFilter, v.provenanceFilter);
            v.selected = 0;
          } else if ((data === "y" || data === "n") && v.view === "ledger") {
            // A verdict is only ever written for a row the reader can see: no
            // write from the calibration pane and none on an already-resolved row.
            const plan = planResolution(state.rows, v.selected);
            if (plan.kind === "write") {
              const row = plan.row;
              const target = v.records.find((r) => r.ts === row.ts && r.question_id === row.question_id);
              if (target) {
                appendResolution(ledgerPath, target.judgment_id, data === "y", new Date().toISOString());
                v.records = readJudgments(ledgerPath);
                v.message = `resolved ${target.judgment_id} → ${data === "y"}`;
                // The resolved row leaves the queue, so the cursor can point past
                // the end; toExplorerState clamps `selected` into the new rows.
                toExplorerState(v, v.height, 0);
              }
            } else if (plan.kind === "already-resolved") {
              v.message = "already resolved";
            }
          }
          tui.requestRender();
        },
        }),
        { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%", margin: 1 } }
      );
    },
  });
}

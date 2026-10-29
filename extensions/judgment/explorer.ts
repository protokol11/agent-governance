// explorer.ts — pure renderer for /judgments. State in, screen lines out.
// No fs, no pi imports. Prior art: session-manager/explorer.ts (Segments).
import type { Provenance } from "./core/types.ts";
export interface Segment {
  text: string;
  color?: "default" | "accent" | "dim" | "muted" | "error" | "success";
}

export interface ExplorerRow {
  ts: string;
  question_id: string;
  value: string;
  confidence: number;
  model: string;
  provenance: string;
  outcome: boolean | null;
  instructions?: string;
  decision?: { action: "act" | "escalate" | "allow" | "deny"; value?: string | null; pricedBy?: string };
  state_excerpt?: string;
}

export interface BinRow {
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  observed: number;
}

export interface ExplorerState {
  stats: { total: number; resolved: number; pending: number; models: string[] };
  view: "calibration" | "ledger";
  bins: BinRow[];
  modelFilter: string | null; // null = all models
  provenanceFilter: Provenance;
  pendingOnly: boolean;
  questionTotals: Array<{ question_id: string; total: number; resolved: number }>;
  rows: ExplorerRow[]; // already filtered + sorted (newest first)
  selected: number;
  detail: ExplorerRow | null;
  message: string | null;
  height: number;
  pendingFallback: boolean;
  width: number;
  offset: number;
  help: boolean;
  questionGroup: string | null;
  questionGroups?: Array<{ group: string; pending: number; total: number }>;
}

/** Rows the ledger window can hold at this height; the keys page by the same count. */
export function bodyFor(height: number): number {
  return Math.max(1, height - 10);
}

/** Smallest offset in [0, max(0, total - body)] that keeps `selected` visible. */
export function offsetFor(selected: number, total: number, body: number): number {
  if (total <= 0) return 0;
  const b = Math.max(1, body);
  const maxOffset = Math.max(0, total - b);
  return Math.min(maxOffset, Math.max(0, selected - b + 1));
}

/** Greedy word wrap; a word wider than the line is hard-split. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > w) {
      if (line) {
        out.push(line);
        line = "";
      }
      out.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= w) line += " " + rest;
    else {
      out.push(line);
      line = rest;
    }
  }
  if (line) out.push(line);
  return out;
}

const FOOTER = " ? help · q close";
const EXCERPT_CHARS = 400;

function seg(text: string, color?: Segment["color"]): Segment {
  return { text, color };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

function clock(ts: string): string {
  const m = ts.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : "--:--";
}

function outText(outcome: boolean | null): Segment {
  if (outcome === true) return seg("true", "success");
  if (outcome === false) return seg("false", "error");
  return seg("PENDING", "accent");
}

export function renderJudgments(state: ExplorerState): Segment[][] {
  const lines: Segment[][] = [];
  const inner = Math.max(10, state.width - 4); // side borders plus padding of the overlay

  // Header
  lines.push([
    seg(" judgments ", "accent"),
    seg(`${state.stats.models.length} models · ${state.stats.total} records · ${state.stats.resolved} resolved · `),
    seg(`${state.stats.pending} PENDING`, state.stats.pending ? "accent" : "muted"),
  ]);
  lines.push([seg("")]);

  if (state.help) {
    lines.push([seg(" HELP", "accent")]);
    for (const [keys, what] of HELP) lines.push([seg(`  ${pad(keys, 13)}${what}`)]);
    lines.push([seg(HELP_NOTE, "muted")]);
    lines.push([seg("")]);
    // The message goes above the footer so `trim` (which keeps the head) never
    // drops the confirmation first; the legend is the last line it sheds.
    if (state.message) lines.push([seg(` ${state.message}`, "success")]);
    lines.push([seg(FOOTER, "dim")]);
    return trim(state, lines);
  }

  // The zero-state check comes after the help branch: `?` must still answer on an
  // empty ledger, otherwise the key is a silent no-op on the first run.
  if (state.stats.total === 0) {
    lines.push([seg("no judgments yet — the ledger warms up as gates record decisions", "muted")]);
    lines.push([seg("call judge / scope_lock, then return here to resolve outcomes", "muted")]);
    if (state.message) lines.push([seg(` ${state.message}`, "success")]);
    lines.push([seg(FOOTER, "dim")]);
    return trim(state, lines);
  }

  const hasGroups = state.view === "ledger" && !!state.questionGroups?.length;
  const messageLines = state.message ? 1 : 0;
  // Everything the layout owes below and above the rows: header 2, title 1,
  // group counts, the "… more" line, the separator, the footer, the message.
  const chrome = 3 + (hasGroups ? 1 : 0) + 1 + 1 + 1 + messageLines;
  // The excerpt is the point of the detail pane, so it takes its lines from the
  // row window instead of being squeezed into whatever is left over.
  const detail = detailBlock(state, inner, Math.max(2, state.height - chrome - 2));
  const window = Math.max(2, Math.min(bodyFor(state.height), state.height - chrome - detail.length));

  let moreLine = false;
  if (state.view === "calibration") {
    lines.push([
      seg(" CALIBRATION", "accent"),
      seg(` ${modelLabel(state.modelFilter)}`, "dim"),
      seg(`  prov: ${state.provenanceFilter}`, "dim"),
      seg("   [tab: ledger]"),
    ]);
    if (!state.bins.length) {
      lines.push([seg("  no resolved records for this filter yet", "muted")]);
    }
    for (const b of state.bins) {
      const gap = Math.round((b.predicted - b.observed) * 100) / 100;
      const flag = Math.abs(gap) > 0.1 && b.n >= 5 ? " ⚠" : "";
      lines.push([
        seg(`  p ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  n=${padStart(String(b.n), 3)}  pred=${b.predicted.toFixed(2)}  obs=${b.observed.toFixed(2)}`),
        seg(`  gap=${gap.toFixed(2)}${flag}`, flag ? "error" : "dim"),
      ]);
    }
    lines.push([seg("")]);
    lines.push([seg(" by question", "accent")]);
    for (const q of state.questionTotals) {
      lines.push([seg(`  ${pad(trunc(q.question_id, 24), 26)} total=${padStart(String(q.total), 3)}  resolved=${q.resolved}`)]);
    }
  } else {
    lines.push([
      seg(" LEDGER", "accent"),
      seg(state.pendingFallback ? "  [all — no pending] " : state.pendingOnly ? "  [pending only] " : "  [all] "),
      seg(modelLabel(state.modelFilter), "dim"),
      seg("   [tab: calibration]"),
    ]);
    // Pending counts per group, so the queue's shape is visible before `g` is pressed.
    if (hasGroups) {
      const counts: Segment[] = [seg(" groups: ", "dim")];
      state.questionGroups!.forEach((g, i) => {
        if (i) counts.push(seg(" · ", "dim"));
        const active = g.group === state.questionGroup;
        counts.push(
          seg(active ? `[${g.group} ${g.pending}/${g.total}]` : `${g.group} ${g.pending}/${g.total}`, active ? "accent" : "muted")
        );
      });
      lines.push(counts);
    }
    const total = state.rows.length;
    // Defensive clamp: the renderer must never lose the cursor, even if the state
    // it is handed a `selected` outside `rows` (a write shrinks the ledger).
    const sel = Math.min(state.selected, Math.max(0, total - 1));
    let offset = Math.min(Math.max(0, state.offset), Math.max(0, total - window));
    // A window narrower than the keys assume can push the cursor out of view;
    // pull it back rather than lose the selected row.
    if (sel < offset) offset = sel;
    if (sel > offset + window - 1) {
      offset = Math.max(0, Math.min(sel - window + 1, Math.max(0, total - window)));
    }
    const visible = state.rows.slice(offset, offset + window);
    if (!visible.length) {
      lines.push([seg("  no rows match the filter — f: toggle pending, m: cycle model", "muted")]);
    }
    visible.forEach((r, i) => {
      const cursor = offset + i === sel ? seg("→ ", "accent") : seg("  ");
      const prov = r.provenance === "code" ? seg(pad(trunc(r.provenance, 5), 6), "muted") : seg(pad(trunc(r.provenance, 5), 6), "dim");
      lines.push([
        cursor,
        seg(`${clock(r.ts)} `),
        seg(pad(trunc(r.question_id, 14), 15)),
        seg(pad(trunc(r.value, 5), 6)),
        seg(padStart(r.confidence.toFixed(2), 5) + "  "),
        prov,
        outText(r.outcome),
      ]);
    });
    moreLine = total > offset + window;
    if (moreLine) {
      lines.push([seg(`  … ${total - offset - window} more (pgdn for more)`, "muted")]);
    }
  }

  lines.push([seg("─".repeat(Math.min(60, state.width)), "dim")]);
  lines.push(...detail);

  // Message above the footer, so a tight screen sheds the legend, not the
  // confirmation the reader just triggered.
  if (state.message) lines.push([seg(` ${state.message}`, "success")]);
  lines.push([seg(FOOTER, "dim")]);
  return trim(state, lines);

  function modelLabel(m: string | null): string {
    return m ? `model: ${m}` : "model: all";
  }

  /**
   * Question, model, decision, then the excerpt wrapped to the inner width.
   * `budget` is what the layout can spare below the rows; an excerpt longer than
   * that is cut with an ellipsis rather than pushing the footer off screen.
   */
  function detailBlock(s: ExplorerState, innerWidth: number, budget: number): Segment[][] {
    if (!s.detail) return [[seg("  (no selection)", "muted")]];
    const d = s.detail;
    const out: Segment[][] = [
      [seg(`  ${trunc(d.question_id, 30)}  `, "accent"), seg(trunc(d.instructions ?? "was this claim true?", 60), "muted")],
      [seg(`  model=${trunc(d.model, 30)}  provenance=${d.provenance}  `, "dim"), outText(d.outcome)],
    ];
    const decisionLines = d.decision ? 1 : 0;
    if (d.decision) {
      const value = d.decision.value ? ` value=${d.decision.value}` : "";
      out.push([seg(`  decision: ${d.decision.action}${value}`, "dim")]);
    }
    const allowed = Math.min(6, budget - 2 - decisionLines);
    const excerpt = d.state_excerpt?.slice(0, EXCERPT_CHARS) ?? "";
    if (allowed > 0 && excerpt) {
      // `innerWidth` is border + padding; the excerpt lines add a 2-space indent
      // of their own, so wrapping to `innerWidth` would overflow by exactly 2.
      const textWidth = Math.max(1, innerWidth - 2);
      const wrapped = wrapText(excerpt, textWidth);
      const shown = wrapped.slice(0, allowed);
      if (wrapped.length > allowed) shown[allowed - 1] = trunc(shown[allowed - 1] + "…", textWidth);
      for (const line of shown) out.push([seg(`  ${line}`, "muted")]);
    }
    return out;
  }
}

const HELP: Array<[string, string]> = [
  ["↑ / ↓", "move the cursor one row"],
  ["tab", "switch ledger / calibration"],
  ["y", "the claim was true — record that verdict"],
  ["n", "the claim was false — record that verdict"],
  ["f", "toggle pending-only"],
  ["m", "cycle the model filter"],
  ["p", "cycle the provenance filter"],
  ["g", "cycle the question group"],
  ["pgup / pgdn", "move one page"],
  ["home / end", "jump to the first / last row"],
  ["?", "toggle this help"],
  ["q / esc", "close the explorer"],
];

// A line of prose rather than a key row, but it belongs in the panel: the meaning
// of a resolution is exactly what the screen must say out loud (ADR-0045).
const HELP_NOTE = '  y/n write only on a PENDING row; a resolved row says "already resolved".';

function trim(state: ExplorerState, lines: Segment[][]): Segment[][] {
  return lines.slice(0, Math.max(1, state.height)).map((line) => clipLine(line, state.width));
}

/** Plain-text IR contract (RTL-03): a joined line never exceeds the width. */
function clipLine(line: Segment[], width: number): Segment[] {
  let left = Math.max(1, width);
  const out: Segment[] = [];
  for (const s of line) {
    if (left <= 0) break;
    if (s.text.length <= left) {
      out.push(s);
      left -= s.text.length;
    } else {
      out.push(seg(trunc(s.text, left), s.color));
      left = 0;
    }
  }
  return out;
}

// tools/annotate-warmup.mjs — repair the inverted 2026-10-02 calibration warm-up.
//
// The warm-up resolved each cp-review row from `known_outcomes[cp]` (the
// violation flag) instead of from "was the judge right". The corpus item is the
// authority for the repair: `outcome = (value === "yes") === known_outcomes[cp]`.
//
// The repair is an append: one `relabel` annotation per wrong row. No ledger
// line is edited or removed. Dry run is the default.
//
// Dry run:
//   node --experimental-strip-types tools/annotate-warmup.mjs \
//     --ledger ../../../../Desktop/Agentic-Engineering/.pi/judgments.jsonl \
//     --items ../../../../Desktop/Agentic-Engineering/.scratch/calibration-warmup/items
//
// Apply runs only on the owner's GO: add `--apply`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendAnnotation, readJudgments } from "../core/ledger.ts";

/** Annotation provenance. Also the idempotence key: this source already ran. */
export const SOURCE = "corpus:.scratch/calibration-warmup";
export const REASON =
  "warmup polarity 2026-10-02: known_outcomes was stored as outcome instead of judge correctness";

/** The batch: 22 items x 18 should-CPs. */
export const WARMUP_TS_PREFIX = "2026-10-02";
export const QUESTION_PREFIX = "cp-review:";
export const EXPECTED_GROUPS = 22;
export const EXPECTED_GROUP_SIZE = 18;

export class WarmupAssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "WarmupAssertionError";
  }
}

/** A warm-up candidate: cp-review, judge-provenance, 2026-10-02, resolved. */
export function isWarmupRow(row) {
  return (
    String(row.question_id ?? "").startsWith(QUESTION_PREFIX) &&
    row.provenance === "judge" &&
    String(row.ts ?? "").startsWith(WARMUP_TS_PREFIX) &&
    typeof row.outcome === "boolean"
  );
}

/** Select the batch rows, keeping ledger order. */
export function selectWarmupRows(records) {
  return records.filter(isWarmupRow);
}

/** Group rows by state_hash in first-seen order. */
export function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const hash = String(row.state_hash);
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(row);
  }
  return [...groups.values()];
}

/** The CP id a row answers, e.g. "CP-01" from "cp-review:CP-01". */
export function cpOf(row) {
  return String(row.question_id).slice(QUESTION_PREFIX.length);
}

/**
 * The relabeled judgment_ids already in the raw ledger lines. Parses raw JSONL
 * so the check does not depend on the fold marking `annotated`.
 */
export function existingRelabelIds(lines) {
  const ids = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn line never blocks the repair read
    }
    if (entry.kind !== "annotation") continue;
    if (entry.op !== "relabel") continue;
    if (entry.source !== SOURCE) continue;
    ids.add(String(entry.judgment_id));
  }
  return ids;
}

function toFoldedMap(folded) {
  if (folded instanceof Map) return folded;
  if (Array.isArray(folded)) return new Map(folded.map((record) => [record.judgment_id, record]));
  return new Map();
}

function toIdSet(existing) {
  if (existing instanceof Set) return existing;
  if (existing instanceof Map) return new Set(existing.keys());
  if (Array.isArray(existing)) return new Set(existing.map(String));
  return new Set();
}

/** Throw when the group shape or a CP set disagrees with the corpus. */
export function assertShape({
  groups,
  items,
  expectedGroups = EXPECTED_GROUPS,
  expectedGroupSize = EXPECTED_GROUP_SIZE,
}) {
  if (groups.length !== expectedGroups) {
    throw new WarmupAssertionError(
      `expected ${expectedGroups} state_hash groups, found ${groups.length}`
    );
  }
  if (items.length !== expectedGroups) {
    throw new WarmupAssertionError(
      `expected ${expectedGroups} corpus items, found ${items.length}`
    );
  }
  const hashes = new Set();
  for (const group of groups) {
    const hash = String(group[0]?.state_hash);
    if (hashes.has(hash)) {
      throw new WarmupAssertionError(`state_hash repeats across groups: ${hash}`);
    }
    hashes.add(hash);
  }
  const itemIds = new Set();
  for (const item of items) {
    if (itemIds.has(item.item_id)) {
      throw new WarmupAssertionError(`item_id repeats: ${item.item_id}`);
    }
    itemIds.add(item.item_id);
  }
  const checked = [];
  groups.forEach((group, index) => {
    const item = items[index];
    if (group.length !== expectedGroupSize) {
      throw new WarmupAssertionError(
        `${item.item_id}: expected ${expectedGroupSize} rows, found ${group.length}`
      );
    }
    const cpIds = new Set(group.map(cpOf));
    const keys = new Set(Object.keys(item.known_outcomes ?? {}));
    const extra = [...cpIds].filter((cp) => !keys.has(cp));
    const missing = [...keys].filter((cp) => !cpIds.has(cp));
    if (extra.length || missing.length) {
      throw new WarmupAssertionError(
        `${item.item_id}: CP set mismatch (extra: ${extra.join(",") || "none"})` +
          ` (missing: ${missing.join(",") || "none"})`
      );
    }
    checked.push({ item_id: item.item_id, state_hash: String(group[0]?.state_hash), cps: cpIds.size });
  });
  return checked;
}

/**
 * The corrected outcome: judge correctness, not the violation flag.
 * A judge "yes" is right when the CP is a real violation. A judge "no" is right
 * when the CP is not a violation.
 */
export function correctedOutcome(row, knownOutcomes) {
  const cp = cpOf(row);
  return (row.value === "yes") === (knownOutcomes[cp] === true);
}

/**
 * Pure planning step. `groups` come from groupRows, `items` are corpus items
 * sorted by item_id, `existing` is the relabel id set, `folded` is the read
 * view. Returns the annotations to append plus per-item counts.
 */
export function planRelabels({
  groups,
  items,
  existing,
  folded,
  expectedGroups = EXPECTED_GROUPS,
  expectedGroupSize = EXPECTED_GROUP_SIZE,
  ts = new Date().toISOString(),
}) {
  const checked = assertShape({ groups, items, expectedGroups, expectedGroupSize });
  const alreadyDone = toIdSet(existing);
  const foldedById = toFoldedMap(folded);
  const relabels = [];
  const perItem = [];

  groups.forEach((group, index) => {
    const item = items[index] ?? {};
    const known = item.known_outcomes ?? {};
    let relabeled = 0;
    let skipped = 0;
    for (const row of group) {
      const judgmentId = String(row.judgment_id);
      if (alreadyDone.has(judgmentId)) {
        skipped += 1;
        continue;
      }
      const current = foldedById.has(judgmentId) ? foldedById.get(judgmentId).outcome : row.outcome;
      const corrected = correctedOutcome(row, known);
      if (corrected === current) continue;
      relabels.push({
        judgment_id: judgmentId,
        op: "relabel",
        outcome: corrected,
        source: SOURCE,
        reason: REASON,
        ts,
      });
      relabeled += 1;
    }
    perItem.push({
      item_id: item.item_id ?? `group-${index + 1}`,
      state_hash: checked[index]?.state_hash ?? String(group[0]?.state_hash),
      rows: group.length,
      relabels: relabeled,
      skipped,
    });
  });

  const skipped = perItem.reduce((sum, entry) => sum + entry.skipped, 0);
  return { relabels, perItem, skipped };
}

/** Defaults match the project root, so the script runs bare from `.pi`'s owner repo. */
function parseArgs(argv) {
  const args = { ledger: ".pi/judgments.jsonl", items: ".scratch/calibration-warmup/items", apply: false };
  const value = (flag, next) => {
    if (next === undefined || next.startsWith("--")) {
      throw new WarmupAssertionError(`${flag} needs a path`);
    }
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--ledger") args.ledger = value(flag, argv[++i]);
    else if (flag === "--items") args.items = value(flag, argv[++i]);
    else throw new WarmupAssertionError(`unknown flag: ${flag}`);
  }
  return args;
}

function loadItems(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const items = files.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  return items.sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
}

function rawLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const lines = rawLines(args.ledger);
  const folded = readJudgments(args.ledger);
  const rows = selectWarmupRows(folded);
  const groups = groupRows(rows);
  const items = loadItems(args.items);
  const existing = existingRelabelIds(lines);

  const { relabels, perItem, skipped } = planRelabels({ groups, items, existing, folded });

  for (const entry of perItem) {
    console.log(`${entry.item_id} rows=${entry.rows} relabels=${entry.relabels} skipped=${entry.skipped}`);
  }

  if (args.apply) {
    for (const annotation of relabels) appendAnnotation(args.ledger, annotation);
  }

  console.log(`${groups.length} groups, ${rows.length} rows, ${relabels.length} relabels, ${skipped} skipped`);
  console.log(args.apply ? `applied ${relabels.length} annotations` : "dry run, no writes");
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const isCli = invoked === import.meta.url;
if (isCli) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`annotate-warmup: ${error.message}`);
    process.exit(1);
  }
}

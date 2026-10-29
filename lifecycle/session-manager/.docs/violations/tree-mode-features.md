---
source:
  commits: "0180ed5 (working tree reviewed, features A/B/C not yet implemented)"
  principle_file: ".agents/skills/to-violations/PRINCIPLES.md"
reviewer: "delegate reviewer (tree-mode conflict review)"
status: "pending-fix"
---

# Violation Fix Spec — tree-mode features A/B/C vs existing explorer design

Pre-implementation design review. Features under review:

- A. Expansion-lens `@n`: TAB sets (focus, focus_depth) on the focused session. The middle pane cuts to descendants at depth n. Orphans carry a `?` badge below.
- B. Failure-autopilot `!`: classify each jsonl tail (ok/error/killed/unknown), build a root→deepest-failed-run spine, hide the rest, cycle deaths on repeat `!`, sidecar status index.
- C. Ancestor-stitching on `/` search: dim `↳` ancestor chains above each survivor, `··· gap` on broken lineage, `a` toggle default ON.

## Summary

- Total violations: 9
- Critical: 2
- High: 6
- Medium: 1
- Low: 0

Safe rollout order (each slice keeps the test gate green and changes one concern):

1. Slice 1, foundation: V008 (key namespace + dispatch table). Feature-agnostic. Do this first.
2. Slice 2, feature A: V001 → V002 → V006 → V004 → V007. Land the lens before any rendering of new kinds.
3. Slice 3, shared ordering: V003. Region-pinned sort is a prerequisite for the B spine and C stitching.
4. Slice 4, feature C: V009 on top of slices 1–3.
5. Slice 5, feature B: V005 first (tail reader + sidecar), then the spine on top of slices 1–3.

Baseline gates: `node --test test/*.test.mjs` = 99 pass, 0 fail. `tsc --noEmit` = 0 errors. Every slice must keep both green.

## Violations

### V001: TAB is already bound to the flat/tree mode toggle

- **Location:** `commands.ts:330-337` (TAB branch), `explorer.ts:245` (`" F3 details    tab tree"` in HELP_LINES)
- **Severity:** critical
- **Principle:** `RTL-2.3-01` — Model state machines explicitly
- **Current state:** TAB flips `mode` between flat and tree and re-expands via `expandAll()`. Feature A assigns TAB to set (focus, focus_depth) on the focused session. One key would run two conflicting handlers.
- **Required state:** TAB sets the lens focus on the focused session row with focus_depth 1. The flat/tree mode toggle moves to a new binding chosen by the user. HELP_LINES lists the new binding. The mode toggle keeps working in both modes.
- **Files to change:**
  1. `commands.ts`
  2. `explorer.ts`
- **Files not to touch:**
  1. `walker.ts`
  2. `metadata.ts`
- **Acceptance criteria:**
  1. TAB sets lens focus and leaves `mode` unchanged.
  2. The new binding toggles mode in flat and tree.
  3. HELP_LINES shows the new toggle binding and the TAB lens hint.
  4. No key dispatches to two handlers.
- **Verification command:** `node --test test/explorer.test.mjs`

### V002: Unified lens state replaces `Set<string> expanded` without a migration plan

- **Location:** `commands.ts:164` (`let expanded = new Set<string>()`), `commands.ts:189-193` (`expandAll()`), `commands.ts:209` (rebuildRows consumers), `explorer.ts:56-62` (`pushSession`), `explorer.ts:74` (`buildTreeRows`)
- **Severity:** high
- **Principle:** `RTL-06` — State is a first-class citizen
- **Current state:** Two consumers read `expanded`: the flat-mode `expanded` set and the tree-mode `expandAll()` set. Feature A replaces both with one (focus, focus_depth) state but names no transition for flat-mode `alt+down/up` pinning.
- **Required state:** One typed `LensState { focus: string | null, focusDepth: number }` plus an optional pinned set for flat mode. One row-builder function consumes both. Flat mode always renders full depth. Tree mode without lens keeps the current full render. `sortRows` stays a pure post-pass.
- **Files to change:**
  1. `commands.ts`
  2. `explorer.ts`
- **Files not to touch:**
  1. `walker.ts`
  2. `metadata.ts`
  3. `teleport.ts`
- **Acceptance criteria:**
  1. One state value feeds one row builder.
  2. Flat mode renders identical rows before and after.
  3. ESC and Shift+TAB decrement focus_depth to zero.
  4. focus_depth never exceeds the depth guard.
- **Verification command:** `node --test test/explorer.test.mjs`

### V003: `sortRows` reorders structural rows and breaks spine and stitching order

- **Location:** `commands.ts:224` (`rows = sortRows(base.map(enrich), sort)`), `explorer.ts:168-181` (`sortRows`)
- **Severity:** high
- **Principle:** `RTL-2.3-03` — Preserve invariants at every step
- **Current state:** `rebuildRows` sorts the whole row list as one bag. Sorting by name interleaves folders and sessions already. Feature B pins a root-to-failure spine. Feature C pins `↳` ancestor chains above survivors. A global sort destroys both.
- **Required state:** Rows carry a region tag. Structural regions (spine, ancestry chain, gap, ellipsis, orphan block) render in fixed order. `sortRows` applies only inside one data region. Lens and search views get an explicit default sort. Orphans stay below the data region.
- **Files to change:**
  1. `commands.ts`
  2. `explorer.ts`
- **Files not to touch:**
  1. `walker.ts`
  2. `tags.ts`
- **Acceptance criteria:**
  1. Sorting reorders rows inside one region only.
  2. Spine order is root-first after any sort press.
  3. Ancestor chains stay above their survivor.
  4. The orphan block stays below the data region.
- **Verification command:** `node --test test/explorer.test.mjs`

### V004: Row model and width contract cannot carry `?`, `✗`, `↳`, and `···` rows

- **Location:** `explorer.ts:4` (`RowKind`), `explorer.ts:12-26` (`Row` type), `explorer.ts:321-347` (`renderMidRow`), `explorer.ts:349-368` (`renderDetailLines`), `explorer.ts:150` (`fit`)
- **Severity:** high
- **Principle:** `RTL-2.1-03` — LEC gate checks regression equivalence
- **Current state:** Four row kinds. `renderMidRow` writes cursor, NAME, MODEL, CTX%, MOD, then a ` +n` child-count suffix. `fit()` truncates the segment list at `width` with one ellipsis. Appending `✗` or `?` after the columns would push the line past the budget and `fit()` would swallow the glyph.
- **Required state:** `RowKind` gains the new kinds with a color each. Structural glyphs render inside the NAME budget or a reserved suffix cell. `fit()` stays the single truncator. New kinds render at widths {120, 100, 72, 48} with every line exactly `width` columns. Existing kinds render byte-identical.
- **Files to change:**
  1. `explorer.ts`
  2. `test/explorer.test.mjs`
- **Files not to touch:**
  1. `walker.ts`
  2. `commands.ts` (dispatch only, no rendering math)
- **Acceptance criteria:**
  1. Line length equals width at all four contract widths.
  2. `✗` and `?` never overflow the middle pane.
  3. Existing row kinds render unchanged output.
  4. `fit()` remains the only truncation path.
- **Verification command:** `node --test test/explorer.test.mjs`

### V005: Tail classification by whole-file reads would double the O(files) cost of every rebuild

- **Location:** `metadata.ts:8-18` (`readRecords` reads and parses whole files), `metadata.ts:52` (`readSessionMeta` iterates every record), `commands.ts:181-199` (`enrich` calls `readSessionMeta` per row on every rebuildRows)
- **Severity:** critical
- **Principle:** `RTL-05` — Optimization without regression is breakage
- **Current state:** Every `rebuildRows` fully reads and parses every visible jsonl. A crash-killed jsonl often has no trailing newline, so a line-based tail read misses it. A naive feature B adds one more full read per file per keypress.
- **Required state:** A bounded tail reader seeks from EOF and caps bytes read. The classifier handles a missing trailing newline. Status results cache in a JSON sidecar keyed by path plus mtime plus size and rewrite via temp file plus rename. `enrich` becomes lazy or the metadata move completes in the same sprint.
- **Files to change:**
  1. `metadata.ts`
  2. `commands.ts`
  3. new `status.ts` (sidecar read/write, pure)
- **Files not to touch:**
  1. `walker.ts`
  2. `explorer.ts`
- **Acceptance criteria:**
  1. Classification reads at most the tail cap per file.
  2. A crash-killed file without trailing newline classifies as killed.
  3. Sidecar writes use temp file plus rename.
  4. mtime or size change invalidates the cached status.
- **Verification command:** `node --test test/metadata.test.mjs`

### V006: Lineage exists only as path nesting, so descendants, ancestry, and gaps need explicit derivation rules

- **Location:** `walker.ts:17` (`SessionNode` has no parent reference), `walker.ts:47` (`MAX_COMPANION_DEPTH = 8`), `walker.ts:53-63` (`collectSessionDeep`), `metadata.ts:26-33` (`readSessionHeader` returns id and cwd only)
- **Severity:** high
- **Principle:** `FOG-OF-WAR` — Treat diagnosis as hypothesis
- **Current state:** Children come only from companion-dir nesting. The jsonl header carries no parentSessionId. Feature A derives descendants from path prefix. Feature C derives ancestry from the stem chain upward. Neither rule is written down and the depth guards can diverge.
- **Required state:** `descendantOf(parent, n)` derives from path prefix and shares `MAX_COMPANION_DEPTH`. Ancestry walks the stem chain upward and stops at the store root. A missing stem in the store renders `··· gap`. The classifier marks malformed tails unknown instead of guessing. Every derivation rule has a unit test.
- **Files to change:**
  1. `walker.ts`
  2. `explorer.ts`
- **Files not to touch:**
  1. `metadata.ts` (header schema unchanged)
  2. `tags.ts`
- **Acceptance criteria:**
  1. Lens and walker share one depth-guard constant.
  2. A missing ancestor stem renders a gap row, not a crash.
  3. No parent ids are invented beyond path nesting.
  4. Malformed tails classify as unknown.
- **Verification command:** `node --test test/walker.test.mjs`

### V007: Orphan sessions have no render rule and would disappear or interleave

- **Location:** `explorer.ts:74-83` (`buildTreeRows`), `commands.ts:209-226` (rebuildRows project branch)
- **Severity:** medium
- **Principle:** `RTL-2.3-03` — Preserve invariants at every step
- **Current state:** The tree render assumes folders and sessions cover the project. The lens cuts the middle pane to descendants of the focus. Non-descendant sessions have no defined place and the session count in the status bar would mismatch the visible rows.
- **Required state:** The lens render puts non-descendant sessions in an orphan block below the descendants block. Each orphan row carries a `?` badge. The status bar keeps counting total sessions. The flat and tree renders stay unchanged.
- **Files to change:**
  1. `explorer.ts`
  2. `commands.ts`
- **Files not to touch:**
  1. `walker.ts`
  2. `metadata.ts`
- **Acceptance criteria:**
  1. The orphan block renders only in lens mode.
  2. Every orphan row shows the `?` badge.
  3. The status bar total stays the full count.
  4. Flat and tree renders keep current output.
- **Verification command:** `node --test test/explorer.test.mjs`

### V008: Key namespace and dispatch have no owner table and no room for `!`, `a`, and `@n`

- **Location:** `commands.ts:253-381` (`handleInput` if/else chain), `teleport.ts:26-33` (`teleportInput` accepts any printable), `teleport.ts:55-64` (`teleportMatches`), `teleport.ts:70-77` (`teleportResolve`)
- **Severity:** high
- **Principle:** `RTL-2.3-01` — Model state machines explicitly
- **Current state:** Dispatch is a flat if/else chain. `a` and `!` are unbound today. Teleport input takes any printable character and has no `@n` syntax. Unhandled keys fall through silently. Feature B needs `!` to cycle a deterministic death list with a terminal no-deaths state. Feature C needs `a` as a toggle.
- **Required state:** One dispatch table maps each key to one handler and one documented owner. `!` cycles deaths in a fixed order and no deaths is a terminal no-op. `a` toggles ancestry display once per press. `teleportResolve` splits the `@n` suffix and returns a lens action. Non-numeric or non-positive n resolves to none.
- **Files to change:**
  1. `commands.ts`
  2. `teleport.ts`
  3. `test/teleport.test.mjs`
- **Files not to touch:**
  1. `walker.ts`
  2. `metadata.ts`
  3. `explorer.ts`
- **Acceptance criteria:**
  1. Every key resolves to at most one handler.
  2. `@0` and `@x` resolve to none.
  3. `!` with no deaths changes nothing.
  4. The table lists owners for all bound keys.
- **Verification command:** `node --test test/teleport.test.mjs`

### V009: Search filter plus ancestor stitching breaks copy, cut, paste, pin, and delete targeting

- **Location:** `commands.ts:285-311` (c/x/p/P branches index `rows[midSelected]` directly), `commands.ts:335-338` (Enter and pendingDelete use `rows[midSelected]`), `explorer.ts:95-101` (`buildRecentRows` is the only flat source)
- **Severity:** high
- **Principle:** `RTL-2.3-03` — Preserve invariants at every step
- **Current state:** Every action indexes the visible row list directly. The current teleport filters only at resolve time and keeps no filter state. Feature C adds live filtering plus ancestor and gap rows. Acting on an ancestor or gap row would target the wrong path or crash the op.
- **Required state:** The filter becomes part of `LensState`. Stitching is render-only and ancestor rows keep a distinct kind. c, x, p, P, d, and Enter act only on rows of kind session or child. Selection clamps on every rebuild, including the zero-row case. The orphan block survives search and pins survive stitching.
- **Files to change:**
  1. `commands.ts`
  2. `explorer.ts`
- **Files not to touch:**
  1. `walker.ts`
  2. `ops.ts`
  3. `pins.ts`
- **Acceptance criteria:**
  1. Ancestor and gap rows reject c, x, p, P, d, and Enter.
  2. Selection clamps when the filter leaves zero rows.
  3. Pinned rows stay pinned during search.
  4. Paste targets the path project after a filter clear.
- **Verification command:** `node --test test/explorer.test.mjs`

## Global verification gate

Run these commands after all fixes:

1. `"C:/Users/HOME/.pi/agent/extensions/planmd/node_modules/.bin/tsc" --noEmit -p tsconfig.json`
2. `node --test test/*.test.mjs` (expect ≥ 99 passing, 0 failing)
3. Width-contract loop in `test/explorer.test.mjs` at widths {120, 100, 72, 48} asserts exact line lengths

## Out of scope

1. Implementing features A, B, or C. This spec lists design constraints and rollout slices only.
2. The live `/ss-explorer` run stays the step of the user per HUMAN-JUDGMENT-FINAL.
3. Changes to the jsonl header schema or the store directory layout.
4. Mouse support, F2 rename, drag-and-drop.
5. `pi resume <path>` deep-link CLI integration.
6. Trash reconcile and restore UI.

## Open questions

1. Which binding replaces TAB for the flat/tree mode toggle in V001?
2. Does the pinned expanded set survive lens focus changes in V002?
3. Sidecar file name and location for V005. Does it follow the pins and aliases dotfile pattern?
4. Is the max `@n` depth fixed at 8 or capped by the data in V006?
5. Does the `a` toggle affect Quick access and alias group views in V009?

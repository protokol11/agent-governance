# setup-upgrade
npm package: [`@protokol11/pi-setup-upgrade`](https://www.npmjs.com/package/@protokol11/pi-setup-upgrade). Source of truth: [agent-governance](https://github.com/protokol11/agent-governance) monorepo.

Dry-run reconciler: classifies repository files against the principles-render stamp.

setup-upgrade is a pi extension that answers one question before any scaffolding or upgrade runs: which files from the generated stamp are already in place, which are missing, and which were edited by hand. The answer comes from the stamp itself plus an identity hash per file, so a repo can be checked without touching it.

## Table of contents

- [Why](#why)
- [Scope and non-scope](#scope-and-non-scope)
- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Commands](#commands)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Why

Files rendered from a stamp drift in two directions. A file can disappear, because the stamp was never applied to this checkout. A file can also gain local edits, and a later render would replace them. Both states look the same to a plain file existence check, and neither is safe to resolve blindly.

setup-upgrade separates them. It runs the renderer twice into temporary directories, compares the two normalized trees, and only then builds a manifest of identity hashes from the render. That manifest is compared with what is on disk, and each path gets a verdict: `ok`, `missing`, or `user-modified`. The render determinism check comes first, so a renderer that changes between runs is reported as an error instead of seeding a manifest that can never match.

No verdict path writes. The extension reports; the person reading decides.

## Scope and non-scope

**Scope:** rendering the stamp twice, rejecting a non-deterministic render, building the manifest in memory, reading expected paths from the working directory, and classifying each path as `ok`, `missing`, or `user-modified`. One session-start notice when `.agentic/manifest.json` is absent or older than the current renderer version.

**Non-scope:** writing, merging, or backing up files. `core.ts` contains `executePlan` with `overwrite`, `keep-user`, and `fail` conflict policies, and the tests cover it, but no command or tool builds a plan or calls it. Plans with `backup` or `merge` operations are skipped by that function. The extension also does not create `.agentic/manifest.json`, install or download the renderer, fetch anything over the network, or print a per-file diff — verdicts only.

## How it works

1. `renderStamp` (`render.ts`) executes `node <renderer> --out <tmpdir>` twice, into two separate directories under the OS temp directory.
2. Both trees are read and compared: the sorted path lists, then `identityHash` per file. A mismatch throws `render non-deterministic: ...`. Both temp directories are removed in a `finally` block.
3. `normalize` (`core.ts`) rewrites any line matching `Generated: YYYY-MM-DD` to `Generated: <date>`. The date is cosmetic and excluded from file identity. `identityHash` is the SHA-256 of the normalized content.
4. `buildManifest` records, for each rendered path, `{ hash, tag: "generated" }`, plus `schema_version: 1`, `generator: "setup-upgrade"`, `renderer_version: "1"`, and a `stamp_hash` over the sorted `path:hash` lines.
5. The command reads each manifest path relative to the session working directory. Only files that exist enter the comparison set.
6. `classify` returns `missing` when the path is absent, `ok` when the identity hash matches, and `user-modified` when the file exists with different normalized content.
7. The command prints a header, then one line per path: the verdict padded to 13 characters, then the path.

**What it writes on disk:** nothing in the repository. The only writes are the two renderer output trees in the OS temp directory, and they are deleted before the command returns. Reading `.agentic/manifest.json` never creates or updates it.

## Quick start

```sh
npm install @protokol11/pi-setup-upgrade
```

Or from a clone of this repo:

```sh
cp -r pi-setup-upgrade ~/.pi/agent/extensions/pi-setup-upgrade
```

Details below.

## Install

**Prerequisites:** Node.js 24 or newer (the extension and tests import `.ts` files directly; observed on v24.13.1), a pi runtime, and the `principles-render` renderer skill whose entry point is `~/.agents/skills/principles-render/render.mjs`. The renderer path is currently a fixed Windows absolute path in `render.ts`; on another operating system the commands fail until that constant is edited (see [Configuration](#configuration)).

Copy the extension directory into the pi agent extensions folder:

```sh
cp -r setup-upgrade ~/.pi/agent/extensions/setup-upgrade
```

Expected: `~/.pi/agent/extensions/setup-upgrade` contains `index.ts`, `core.ts`, `fs.ts`, `render.ts`, `types.ts`, `test/core.test.mjs`, and `package.json`. No configuration file is created.

## Usage

Restart pi so the extension loads, open a repository at its root, and run the upgrade command. The lines below are the real result of the function the command calls, run headlessly against a repository that holds `.agentic/manifest.json`, one stamp file in its original state, one stamp file with a local edit, and the remaining stamp paths absent:

```text
/upgrade-repo
upgrade-repo (dry-run, 0 writes):
missing       cp-corpus.json
missing       lint-rules.md
ok            must-card.md
missing       role-prompts/coder.md
missing       role-prompts/explore.md
missing       role-prompts/fixer.md
missing       role-prompts/plan.md
missing       role-prompts/tester.md
user-modified spec-template.md
```

Read it top to bottom. `ok` means the file still matches the stamp, with the `Generated:` date ignored. `user-modified` means the file exists but differs from the render, so a later overwrite would lose local edits. `missing` means the stamp path is not present in this checkout. The header states the write count; it stays `0`.

The same run is available as the `upgrade_repo` tool, so an agent can call it and receive the table as text. Both commands and both tools execute the identical function.

## Commands

| Command | Tool | Arguments | Effect | Writes |
|---|---|---|---|---|
| `/setup-repo` | `setup_repo` | ignored | Renders the stamp twice, classifies the working directory, prints the verdict table | 0 |
| `/upgrade-repo` | `upgrade_repo` | ignored | Same function as `/setup-repo` | 0 |
| — | — | — | `session_start` hook reads `.agentic/manifest.json` and emits one notice | 0 |

The `session_start` hook reports three states: manifest absent (`setup candidate (run /setup-repo)`), `renderer_version` lower than `1` (`upgrade candidate (run /upgrade-repo)`), or manifest unreadable (a warning carrying the parse error). Hook errors are swallowed so a failed check does not stop the session from starting.

## Configuration

There is no configuration file and no environment variable. These values are fixed in the source:

| Setting | Location | Value | Effect |
|---|---|---|---|
| Renderer path | `render.ts`, `RENDERER` | `C:\Users\HOME\.agents\skills\principles-render\render.mjs` | Executed as `node <path> --out <dir>` for each of the two renders |
| Manifest path | `index.ts`, `MANIFEST_REL` | `.agentic/manifest.json` | Read relative to the session working directory; never written |
| Current renderer version | `index.ts`, `CURRENT_RENDERER_VERSION` | `"1"` | Compared as a string with `manifest.renderer_version`; a lower value triggers the session-start upgrade notice |
| Generator name | `core.ts`, `buildManifest` default | `setup-upgrade` | Stored in the in-memory manifest |
| Identity normalization | `core.ts`, `normalize` | `Generated: YYYY-MM-DD` → `Generated: <date>` | Keeps the render date out of every file hash |
| Verdict column width | `index.ts` | 13 characters | Alignment only; does not truncate long paths |

`renderStamp` accepts `{ renderer }` as an override, and the tests use it, but no command or tool passes a value, so the constant above is the path that runs.

## Troubleshooting

- **Symptom:** a command fails with `spawnSync node ENOENT` or `Cannot find module ...render.mjs`. **Cause:** the fixed renderer path does not exist on this machine, usually because the operating system is not Windows or the skill is installed elsewhere. **Fix:** install the renderer at that path, or change `RENDERER` in `render.ts`; the command layer exposes no override.
- **Symptom:** `render non-deterministic: file sets differ` or `render non-deterministic: content differs at <path>`. **Cause:** two consecutive renders produced different paths or different normalized content, such as an unnormalized timestamp, a random value, or unordered output. **Fix:** remove the source of variance in the renderer, or extend `normalize` if the varying line is cosmetic. The extension rejects the render on purpose.
- **Symptom:** `/setup-repo` prints a header that starts with `upgrade-repo`. **Cause:** both command handlers call `upgradeRepoDryRun`, and that function owns the header text. **Fix:** read the verdict lines; the classification is the same. Change the header in `index.ts` if the label matters.
- **Symptom:** every path reports `missing` although the files exist somewhere in the checkout. **Cause:** the manifest paths are resolved against the session working directory, not against the repository root discovered from git. **Fix:** start pi at the repository root, then rerun the command.
- **Symptom:** the session-start notice says `manifest not found — setup candidate`. **Cause:** the repository has no `.agentic/manifest.json`. **Fix:** expected for a repository that has not been rendered yet; this extension does not create the manifest.
- **Symptom:** the session-start notice says `manifest unreadable: ...`. **Cause:** `.agentic/manifest.json` is not valid JSON, often after a manual edit. **Fix:** restore valid JSON; the commands still run but classify against the current render, not the stored manifest.
- **Symptom:** the notice says `renderer 0 < 1 — upgrade candidate`. **Cause:** `renderer_version` is missing or older than `"1"`. The comparison is lexicographic, so a future `"10"` compares lower than `"2"`. **Fix:** re-render to write the current version, and extend the comparison before adopting a two-digit version.

## Contributing

File issues in `protokol11/agent-governance` under `extras/setup-upgrade`. Run the tests before sending a change:

```sh
node --test test/*.test.mjs
```

The suite holds 5 tests and runs headless: the core is imported with the in-memory file adapter, and the determinism test drives two mock renderers from a temporary directory. No pi runtime and no real renderer are needed for the tests.

## License

[MIT](../../LICENSE)

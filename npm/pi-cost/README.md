# cost
npm package: [`@protokol11/pi-cost`](https://www.npmjs.com/package/@protokol11/pi-cost). Source of truth: [agent-governance](https://github.com/protokol11/agent-governance) monorepo.

Multi-currency cost footer for pi sessions: `/yuan`, `/yen`, `/usd` over OpenRouter session history.

cost is a pi extension (renamed from `yuan`). It scans `~/.pi/agent/sessions`, totals per-session, month, and all-time cost in USD, and renders it in CNY, JPY, or USD — in the terminal on demand and as a persistent footer block owned by the `ctx262` extension.

## Table of contents

- [Why](#why)
- [Install](#install)
- [Usage](#usage)
- [CLI](#cli)
- [Configuration](#configuration)
- [API](#api)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Why

Cost visibility should not depend on one currency. The pipeline treats cost reporting as a cross-cutting concern (see `.docs/PIPELINE.md`), so the totals live in one shared, currency-agnostic cache and each command projects them into its own currency with a user-set rate. Nothing fetches rates on its own: the user sets each rate once and judges whether it stays fair.

The harder lesson is ownership. On 2026-09-14 two extensions both called `ctx.ui.setFooter` — pi resolves that as last-one-wins, and one footer silently clobbered the other. The fix was a single owner: `ctx262.ts` renders the footer; this extension registers the commands and exposes `renderCostBlock` / `loadFooterSettings` from `core.ts`, which `ctx262` imports. The principle holds anywhere a shared resource has more than one writer: one owner, explicit imports, no side-effect writes from a second party. This incident is closed.

The extension was renamed from `yuan` to `cost` before its first publication; the three commands stay as they are.

**Scope:** per-session, month, and all-time cost in three currencies; footer block composition; user-set rates with a 10-minute cache.

**Non-scope:** fetching live exchange rates, non-OpenRouter billing, per-model or per-day breakdowns.

## Prerequisites

- Node.js 24+ (runs `.ts` directly via type stripping).
- pi with OpenRouter sessions under `~/.pi/agent/sessions`.
- The `ctx262` extension, which owns the footer and imports from this `core.ts`.

## Quick start

```sh
npm install @protokol11/pi-cost
```

Or from a clone of this repo:

```sh
cp -r pi-cost ~/.pi/agent/extensions/pi-cost
```

Details below.

## Install

Copy this directory into the pi extensions folder:

```sh
cp -r extras/cost ~/.pi/agent/extensions/cost
```

Expected: `~/.pi/agent/extensions/cost` contains `index.ts`, `core.ts`, and a `config.json` created on first run (default CNY rate 6.7, JPY 157.8).

## Usage

Restart pi, then:

```
/yuan
```

Real output:

```
yuan: scanning session history…
yuan: session CN¥1.11 · month CN¥42.30 · all-time CN¥318.75 (rate 6.72, 3 min ago)
```

The cached month and all-time figures are as fresh as the TTL cache — the output always states the rate and the cache age next to them.

## CLI

Three commands with identical subcommands; USD is the base, so `/usd` has no `set`:

- `/yuan`, `/yen`, `/usd` — show session, month, and all-time cost in that currency.
- `/<cmd> set <rate>` — set CNY or JPY per USD (`/yuan set 6.72`). Stored in `config.json`; nothing else updates it.
- `/<cmd> <session|month|all> view|hide` — toggle each footer figure.
- `/<cmd> change sign [sign|reset]` — cycle or set the currency sign (defaults `CN¥` / `JP¥` / `$`).
- `/<cmd> fresh` — force a rescan of the session files, bypassing the cache.

## Configuration

One `config.json` beside `core.ts`, patched atomically (a `set` never drops the other keys).

| Key | Type | Default | Effect |
|---|---|---|---|
| `rate` | number | 6.7 | CNY per USD (`/yuan set`). |
| `jpy` | number | 157.8 | JPY per USD (`/yen set`). |
| `view` | object | all shown | Per-command `session` / `month` / `all` visibility flags. |
| `signs` | object | `CN¥` / `JP¥` / `$` | Per-command sign overrides. |

`cache.json` in the same directory holds the shared USD totals; it is written only by the commands, never by the footer, and refreshes after 10 minutes.

## API

`core.ts` is pure (no pi imports) and headless-testable. The footer owner imports:

```ts
import { renderCostBlock, loadFooterSettings } from "./core.ts";

// renderCostBlock(0.165, cache, rates, views) -> "$0.165 CN¥1.11 JP¥22.36"
```

Other exports cover the full seam: `loadRate` / `saveRate`, `loadJpyRate` / `saveJpyRate`, `loadSign` / `saveSign` / `cycleSign`, `loadView` / `saveViewFlag`, `loadCache` / `saveCache` / `isFresh`, `formatAmount`, `sessionCostUsd`, `collectSessionFiles` / `scanSessionFiles`.

## Troubleshooting

- **Symptom:** footer shows no cost figures. **Cause:** all view flags hidden, or the cache is stale and no command has refreshed it. **Fix:** `/yuan session view | month view | all view`, then `/yuan fresh`.
- **Symptom:** `/usd set 1` warns "USD is the base currency". **Cause:** USD totals come from OpenRouter and need no conversion. **Fix:** nothing to set; use `/yuan set` or `/yen set`.
- **Symptom:** footer and command disagree. **Cause:** the footer reads the cache while the command shows cache age with its figures. **Fix:** `/yuan fresh` on both sides.

## Contributing

File issues in the parent monorepo (`protokol11/agent-governance`), `extras/cost`. Run the tests with:

```sh
node --test test/*.test.mjs
```

Current suite: 48 passing, headless against `core.ts` (no pi runtime needed).

## License

[MIT](../../LICENSE)

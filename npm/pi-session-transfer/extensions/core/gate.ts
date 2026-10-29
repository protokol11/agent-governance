// session-transfer core — deterministic gate (key 1) + the passive band alert
// absorbed from context-guard (decision 13). Pure math + env config.
//
// Transfer threshold = min(0.70 * contextWindow, 150_000) — the same "degradation
// zone" context-guard used. Idle is measured from the LAST USER INPUT; the session
// must also be at/over threshold.
//
// Band math (ok < warn < critical) lives here too so one extension owns the whole
// context lifecycle: while the user is present the band alert appends a wrap-up
// guideline; when the session is idle AND hot the transfer gate fires. The agent
// channel (begin_transfer) is band-gated here too, reusing the same band math.
import type { TransferState } from "./fsm.ts";

export const THRESHOLD_FRACTION = 0.7;
export const THRESHOLD_TOKEN_CAP = 150_000;
export const CRITICAL_FRACTION = 0.85;
export const CRITICAL_TOKEN_CAP = 200_000;
export const DEFAULT_IDLE_MIN = 30;
export const DEFAULT_IDLE_MS = DEFAULT_IDLE_MIN * 60_000;

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent?: number | null;
}

export interface GateConfig {
  /** Absolute token threshold override, or null to use the formula. */
  thresholdTokens: number | null;
  idleMs: number;
  /** Hard off-switch — makes the gate a no-op. */
  disabled: boolean;
  /**
   * Automatic triggering (idle gate + agent `begin_transfer` + the band
   * call-to-action guideline). OFF by default: the user was caught by an
   * unrequested idle rotation and wants every transfer to be explicit.
   * Manual `/transfer` and `/transfer-resume` do not consult this flag.
   * Opt in with `SESSION_TRANSFER_AUTO=1`.
   */
  auto: boolean;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  thresholdTokens: null,
  idleMs: DEFAULT_IDLE_MS,
  disabled: false,
  auto: false,
};

export function thresholdFor(contextWindow: number): number {
  return Math.min(THRESHOLD_FRACTION * contextWindow, THRESHOLD_TOKEN_CAP);
}

// ---- band math (absorbed from context-guard, decision 13) -------------------

export type Band = "ok" | "warn" | "critical";

export interface BandConfig {
  /** Absolute warn threshold override, or null to use the formula. */
  warnTokens: number | null;
  /** Absolute critical threshold override, or null to use the formula. */
  criticalTokens: number | null;
}

export const DEFAULT_BAND_CONFIG: BandConfig = { warnTokens: null, criticalTokens: null };

export function criticalThresholdFor(contextWindow: number): number {
  return Math.min(CRITICAL_FRACTION * contextWindow, CRITICAL_TOKEN_CAP);
}

export function bandConfigFromEnv(env: Record<string, string | undefined> = process.env): BandConfig {
  return {
    warnTokens: positiveNumber(env.CONTEXT_GUARD_WARN_TOKENS),
    criticalTokens: positiveNumber(env.CONTEXT_GUARD_CRITICAL_TOKENS),
  };
}

export function bandThresholds(
  usage: ContextUsageLike,
  cfg: BandConfig = DEFAULT_BAND_CONFIG,
): { warn: number; critical: number } {
  return {
    warn: cfg.warnTokens ?? thresholdFor(usage.contextWindow),
    critical: cfg.criticalTokens ?? criticalThresholdFor(usage.contextWindow),
  };
}

export function bandFor(usage: ContextUsageLike | undefined, cfg: BandConfig = DEFAULT_BAND_CONFIG): Band {
  if (!usage || usage.tokens === null || usage.tokens === undefined) return "ok";
  const { warn, critical } = bandThresholds(usage, cfg);
  if (usage.tokens >= critical) return "critical";
  if (usage.tokens >= warn) return "warn";
  return "ok";
}

export function bandRank(band: Band): number {
  if (band === "critical") return 2;
  if (band === "warn") return 1;
  return 0;
}

// ---- agent-initiated transfer guard ----------------------------------------

export type BeginGuardReason = "disabled" | "busy" | "not_hot";

/**
 * Pure guard for the agent-owned `begin_transfer` tool. Idle is deliberately
 * NOT required: the agent acts while the user is present, which is the whole
 * point. The single key is the band (agent judgment replaces gate + observer).
 */
export function beginGuard(
  state: TransferState,
  disabled: boolean,
  band: Band,
): { ok: true } | { ok: false; reason: BeginGuardReason } {
  if (disabled) return { ok: false, reason: "disabled" };
  if (state !== "idle") return { ok: false, reason: "busy" };
  if (bandRank(band) < bandRank("warn")) return { ok: false, reason: "not_hot" };
  return { ok: true };
}

/** True only on an upward band crossing (ok->warn, warn->critical, ok->critical). */
export function shouldNotify(lastBand: Band, newBand: Band): boolean {
  return bandRank(newBand) > bandRank(lastBand);
}

export function currentPercent(usage: ContextUsageLike): number {
  if (usage.percent !== null && usage.percent !== undefined) return Math.round(usage.percent);
  const tokens = usage.tokens ?? 0;
  return Math.round((tokens / usage.contextWindow) * 100);
}

const WRAP_UP_GUIDELINE =
  "Context budget: this session is at ~{pct}% of its window (degradation zone). " +
  "Act now: (1) call the `begin_transfer` tool, " +
  "(2) run `hands-off` + `update-docs` to write the handoff and session status, " +
  "(3) call `request_transfer` with the handoff path. " +
  "Do not start new work.";

/** Wrap-up guideline for warn/critical, or null while the band is ok. */
export function guidelineFor(band: Band, usage: ContextUsageLike | undefined): string | null {
  if (band === "ok" || !usage || usage.tokens === null || usage.tokens === undefined) return null;
  return WRAP_UP_GUIDELINE.replace("{pct}", String(currentPercent(usage)));
}

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function truthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): GateConfig {
  const idleMin = positiveNumber(env.SESSION_TRANSFER_IDLE_MIN);
  return {
    thresholdTokens: positiveNumber(env.SESSION_TRANSFER_THRESHOLD_TOKENS),
    idleMs: idleMin === null ? DEFAULT_IDLE_MS : idleMin * 60_000,
    disabled: truthy(env.SESSION_TRANSFER_DISABLE),
    auto: truthy(env.SESSION_TRANSFER_AUTO),
  };
}

/** True only when the session is hot AND has been idle long enough. */
export function gateFires(
  usage: ContextUsageLike | undefined,
  idleElapsedMs: number,
  cfg: GateConfig = DEFAULT_GATE_CONFIG,
): boolean {
  if (cfg.disabled) return false;
  if (!usage || usage.tokens === null || usage.tokens === undefined) return false;
  if (idleElapsedMs < cfg.idleMs) return false;
  const threshold = cfg.thresholdTokens ?? thresholdFor(usage.contextWindow);
  return usage.tokens >= threshold;
}

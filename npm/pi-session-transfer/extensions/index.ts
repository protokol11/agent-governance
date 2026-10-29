// session-transfer — replace lossy compaction with a session handoff + in-place
// rotation. Entries (ADR-0037):
//   `/transfer`                                (packaging only: handoff + status
//                                               + name_session; NO new session)
//   `/transfer-resume`                         (reuse-or-produce handoff, then
//                                               rotate + auto-start the child)
//   implicit gate (usage≥threshold AND idle)   (OFF by default; opt in SESSION_TRANSFER_AUTO=1)
//   agent `begin_transfer` at band≥warn        (OFF by default; opt in SESSION_TRANSFER_AUTO=1)
// Automatic transfer is disabled by default: no idle rotation, no band call-to-
// action guideline, `begin_transfer` rejected. `/transfer` (packaging) and
// `/transfer-resume` (explicit rotation) stay available; `SESSION_TRANSFER_DISABLE`
// remains the hard off-switch for both automatic paths.
// Per ADR-0036 the transfer instruction rides `before_agent_start` as a system
// guideline; the turn is a neutral marker (never English user-role prose).
// The agent authors the handoff (hands-off + update-docs) and arms the transfer
// with the `request_transfer` tool; non-explicit channels ask the user before
// rotating, explicit `/transfer-resume` rotates immediately. Built on the
// live-confirmed escape hatch:
//   hook -> pi.sendUserMessage("/transfer-rotate", {expandPromptTemplates:true})
//        -> ExtensionCommandContext.newSession.
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  INITIAL_MEMORY,
  reduce,
  shouldRotate,
  type FsmMemory,
  type TransferChannel,
} from "./core/fsm.ts";
import {
  bandConfigFromEnv,
  bandFor,
  beginGuard,
  configFromEnv,
  currentPercent,
  gateFires,
  shouldNotify,
  type Band,
  type BandConfig,
  type ContextUsageLike,
  type GateConfig,
} from "./core/gate.ts";
import { OBSERVER_SYSTEM, buildObserverUser, parseVerdict } from "./core/observer.ts";
import { buildSeed, readHandoffSessionId, readNextSessionMode } from "./core/seed.ts";
import { TRANSFER_MARKER, buildGuidelines, packagingPrompt } from "./core/instruction.ts";

const DEFAULT_OBSERVER_MODEL = "deepseek/deepseek-flash";
const OBSERVER_MAX_ENTRIES = 20;
const IDLE_RETRY_MS = 60_000;

function textOf(message: { content?: Array<{ type: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function textResult(
  text: string,
  isError = false,
): { content: { type: "text"; text: string }[]; isError: boolean; details: undefined } {
  return { content: [{ type: "text", text }], isError, details: undefined };
}

function truthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Model/thinking carried across a rotation. Set by the parent just before
// `ctx.newSession`; applied by the child's `session_start` handler, which runs
// on a fresh factory instance whose `pi` is active. The parent's captured `pi`
// is stale after replacement and the replaced ctx exposes no setters, so this
// module-scoped queue is the only working transport (the module is cached per
// generation, so both factory instances share it).
type CarryState = {
  model: ExtensionContext["model"];
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
} | null;

let pendingCarry: CarryState = null;

function bandNotifyMessage(band: Band, usage: ContextUsageLike): string {
  const severity = band === "critical" ? "critical" : "warning";
  return `Context guard: ${severity} — this session is at ~${currentPercent(usage)}% (${usage.tokens} tokens). Wrap up and check in with the user.`;
}

function transferPrompt(sessionId: string): string {
  return [
    "SESSION TRANSFER requested. Do exactly this, then stop:",
    "1. Run the `hands-off` skill to write a handoff snapshot under `.docs/handoff/`.",
    "2. Run the `update-docs` skill to write the session status and update `.docs/CURRENT_STATUS.md`.",
    `3. Ensure the handoff frontmatter contains \`sessionId: ${sessionId}\` and \`next_session_mode\`.`,
    "4. Call the `request_transfer` tool with the handoff file path.",
    "Do not start new work.",
  ].join("\n");
}

export default function sessionTransfer(pi: ExtensionAPI): void {
  const cfg: GateConfig = configFromEnv(process.env);
  const bandCfg: BandConfig = bandConfigFromEnv(process.env);
  let lastBand: Band = "ok";
  // Pending transfer instruction (ADR-0036): armed by startTransfer, consumed
  // once by before_agent_start, always cleared.
  let pendingInstruction: string | null = null;
  let mem: FsmMemory = { ...INITIAL_MEMORY };
  let lastUserInputAt = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rotationDispatched = false;

  const logPath = (cwd: string): string => join(cwd, CONFIG_DIR_NAME, "session-transfer.log");
  const log = (cwd: string, message: string): void => {
    try {
      const path = logPath(cwd);
      mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // a transfer helper must never break the session it serves
    }
  };

  const markUserInput = (at: number): void => {
    lastUserInputAt = at;
  };

  const clearTimer = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const scheduleIdle = (ctx: ExtensionContext): void => {
    clearTimer();
    const wait = Math.max(0, cfg.idleMs - (Date.now() - lastUserInputAt));
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void onIdle(ctx);
    }, wait);
    idleTimer.unref?.();
  };

  const startTransfer = (channel: TransferChannel, ctx: ExtensionContext): void => {
    mem = reduce(mem, { type: "trigger", channel });
    log(ctx.cwd, `transfer started (channel=${channel})`);
    const label = channel === "explicit_resume" ? "resume transfer" : `${channel} transfer`;
    if (ctx.hasUI) ctx.ui.notify(`session-transfer: ${label} — writing handoff and status`, "info");
    // ADR-0036: the load-bearing instruction rides the next `before_agent_start`
    // as a system guideline; the turn itself is a language-neutral marker.
    pendingInstruction = transferPrompt(ctx.sessionManager.getSessionId());
    pi.sendUserMessage(TRANSFER_MARKER);
  };

  const onIdle = async (ctx: ExtensionContext): Promise<void> => {
    try {
      if (cfg.disabled || mem.state !== "idle") return;
      // ADR-0037 follow-up: automatic rotation is off by default (SESSION_TRANSFER_AUTO=1 opts in).
      if (!cfg.auto) return;
      if (!ctx.isIdle()) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          void onIdle(ctx);
        }, IDLE_RETRY_MS);
        idleTimer.unref?.();
        return;
      }
      const usage = ctx.getContextUsage();
      if (!gateFires(usage as ContextUsageLike | undefined, Date.now() - lastUserInputAt, cfg)) return;
      const transcript = recentTranscript(ctx);
      const confirmed = await askObserver(ctx, transcript, cfg);
      if (!confirmed || mem.state !== "idle") return; // observer latency: user may have spoken
      startTransfer("implicit", ctx);
    } catch {
      // fail-silent: the gate/observer must never break the session
    }
  };

  const recentTranscript = (ctx: ExtensionContext): string => {
    const entries = ctx.sessionManager.getEntries().filter((e) => e.type === "message");
    const lines: string[] = [];
    for (const entry of entries.slice(-OBSERVER_MAX_ENTRIES)) {
      const message = (entry as { message?: Record<string, unknown> }).message;
      if (!message) continue;
      const role = typeof message.role === "string" ? message.role : "?";
      const content = message.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in b)
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(" ");
      }
      if (text) lines.push(`${role}: ${text.slice(0, 500)}`);
    }
    return lines.join("\n");
  };

  const observerModel = (ctx: ExtensionContext) => {
    const raw = process.env.SESSION_TRANSFER_OBSERVER_MODEL ?? DEFAULT_OBSERVER_MODEL;
    const slash = raw.indexOf("/");
    if (slash <= 0) return undefined;
    return ctx.modelRegistry.find(raw.slice(0, slash), raw.slice(slash + 1)) ?? undefined;
  };

  const askObserver = async (ctx: ExtensionContext, transcript: string, _cfg: GateConfig): Promise<boolean> => {
    const call = async (model: NonNullable<ReturnType<typeof observerModel>>): Promise<string> => {
      const message = await ctx.modelRegistry.complete(
        model,
        { systemPrompt: OBSERVER_SYSTEM, messages: [{ role: "user", content: buildObserverUser(transcript), timestamp: Date.now() }] },
        { signal: ctx.signal, thinkingLevel: "low" },
      );
      return textOf(message as { content?: Array<{ type: string; text?: string }> });
    };
    try {
      const primary = observerModel(ctx);
      if (primary) {
        let verdict = parseVerdict(await call(primary));
        if (!verdict) verdict = parseVerdict(await call(primary)); // one retry
        if (verdict) return verdict.candidate;
      }
      // Fallback: the current session model, once.
      if (ctx.model && ctx.model !== primary) {
        const verdict = parseVerdict(await call(ctx.model));
        if (verdict) return verdict.candidate;
      }
    } catch {
      // fail-silent → not a candidate
    }
    return false;
  };

  const ensureSessionId = (handoffPath: string, sessionId: string): void => {
    const body = readFileSync(handoffPath, "utf8");
    if (/^sessionId:\s*\S/m.test(body)) return;
    const lines = body.split("\n");
    if (lines[0]?.trim() !== "---") return; // no frontmatter; leave as-is
    lines.splice(1, 0, `sessionId: ${sessionId}`);
    writeFileSync(handoffPath, lines.join("\n"));
  };

  // ADR-0037: the newest handoff already carrying this session's id, so
  // `/transfer-resume` can skip re-running the packaging skills.
  const findHandoffForSession = (cwd: string, sessionId: string): string | null => {
    const dir = join(cwd, ".docs", "handoff");
    if (!existsSync(dir)) return null;
    let best: { path: string; mtime: number } | null = null;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const path = join(dir, name);
        try {
          if (readHandoffSessionId(readFileSync(path, "utf8")) !== sessionId) continue;
          const mtime = statSync(path).mtimeMs;
          if (!best || mtime > best.mtime) best = { path, mtime };
        } catch {
          // unreadable candidate → skip
        }
      }
    } catch {
      return null;
    }
    return best ? best.path : null;
  };

  // ---- seams ---------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    mem = { ...INITIAL_MEMORY };
    lastBand = "ok";
    rotationDispatched = false;
    markUserInput(Date.now());
    scheduleIdle(ctx);
    // Apply a model/thinking carry queued by the parent before rotation.
    const carry = pendingCarry;
    if (carry) {
      pendingCarry = null;
      try {
        if (carry.model) {
          const ok = await pi.setModel(carry.model);
          if (!ok) log(ctx.cwd, "carry: setModel returned false (auth missing?)");
        }
        pi.setThinkingLevel(carry.thinking); // after setModel: clamps to its capabilities
        log(ctx.cwd, "carry: restored parent model/thinking");
      } catch (error) {
        log(ctx.cwd, `carry: restore failed: ${String(error)}`);
      }
    }
  });

  // Passive band alert (absorbed from context-guard, decision 13): when the
  // session is hot while the user is present, append a wrap-up guideline and
  // notify once per upward band crossing. The transfer gate owns the idle path.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    // ADR-0036: consume the pending instruction once, unconditionally — even if
    // the band logic throws, it must never leak into a later real prompt.
    const instruction = pendingInstruction;
    pendingInstruction = null;
    try {
      const usage = ctx.getContextUsage() as ContextUsageLike | undefined;
      const band = bandFor(usage, bandCfg);
      // When auto-transfer is off, drop the band call-to-action guideline (it tells
      // the agent to call begin_transfer) but keep the passive band notification.
      const { guidelines } = buildGuidelines(band, cfg.auto ? usage : undefined, instruction);
      for (const guideline of guidelines) event.systemPromptOptions.promptGuidelines.push(guideline);
      if (usage && band !== "ok" && shouldNotify(lastBand, band)) {
        ctx.ui.notify(bandNotifyMessage(band, usage), band === "critical" ? "error" : "warning");
      }
      lastBand = band;
    } catch {
      // A guard must never break the run it guards.
    }
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return; // our own injected prompts are not user activity
    markUserInput(Date.now());
    mem = reduce(mem, { type: "user_message" });
    clearTimer();
    scheduleIdle(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!shouldRotate(mem) || rotationDispatched) {
      mem = reduce(mem, { type: "agent_settled" });
      return;
    }
    const channel = mem.channel;
    // ADR-0037: non-explicit channels never rotate silently — propose and wait
    // (no timeout: no answer means no rotation).
    if (channel === "implicit" || channel === "agent") {
      let approved = false;
      try {
        if (ctx.hasUI) {
          approved = await ctx.ui.confirm(
            "Session transfer",
            "Context is hot and the session is idle. Move to a fresh session from this handoff now?",
          );
        }
      } catch {
        approved = false;
      }
      if (!approved) {
        mem = reduce(mem, { type: "user_message" }); // human declined → abandon
        log(ctx.cwd, `transfer not confirmed (channel=${channel})`);
        if (ctx.hasUI) ctx.ui.notify("session-transfer: transfer skipped — session unchanged", "info");
        return;
      }
    }
    rotationDispatched = true;
    log(ctx.cwd, "armed — dispatching /transfer-rotate");
    pi.sendUserMessage("/transfer-rotate", { expandPromptTemplates: true });
  });

  pi.registerCommand("transfer", {
    description: "Package this session into a handoff + status (no new session)",
    handler: async (_args, ctx) => {
      if (mem.state !== "idle") {
        ctx.ui.notify("session-transfer: a transfer is already in progress", "warning");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("session-transfer: writing handoff + status (no rotation)", "info");
      pendingInstruction = packagingPrompt(ctx.sessionManager.getSessionId());
      pi.sendUserMessage(TRANSFER_MARKER);
    },
  });

  pi.registerCommand("transfer-resume", {
    description: "Write/reuse a handoff and auto-start a fresh session from it",
    handler: async (_args, ctx) => {
      if (mem.state !== "idle") {
        ctx.ui.notify("session-transfer: a transfer is already in progress", "warning");
        return;
      }
      const existing = findHandoffForSession(ctx.cwd, ctx.sessionManager.getSessionId());
      if (existing) {
        // ADR-0037: reuse the handoff already written for this session.
        mem = reduce(mem, { type: "trigger", channel: "explicit_resume" });
        mem = reduce(mem, { type: "docs_ready", path: existing });
        log(ctx.cwd, `armed from existing ${existing}`);
        rotationDispatched = true;
        log(ctx.cwd, "armed — dispatching /transfer-rotate");
        pi.sendUserMessage("/transfer-rotate", { expandPromptTemplates: true });
        return;
      }
      startTransfer("explicit_resume", ctx);
    },
  });

  pi.registerCommand("transfer-rotate", {
    description: "Internal: rotate to a fresh session seeded from the armed handoff",
    handler: async (_args, ctx) => {
      rotationDispatched = false;
      const path = mem.handoffPath;
      const channel = mem.channel;
      mem = reduce(mem, { type: "rotation_dispatched" });
      if (!path) {
        ctx.ui.notify("session-transfer: nothing armed to rotate", "warning");
        return;
      }
      // Capture the parent's context BEFORE newSession — `ctx` is stale after it.
      const cwd = ctx.cwd;
      const hasUI = ctx.hasUI;
      try {
        ensureSessionId(path, ctx.sessionManager.getSessionId());
        const nextMode = readNextSessionMode(readFileSync(path, "utf8"));
        await ctx.waitForIdle();
        const sessionFile = ctx.sessionManager.getSessionFile();
        // ADR-0036: pointer-only everywhere; only /transfer-resume (or the env
        // override) auto-starts the child.
        const autoResume = channel === "explicit_resume" || truthy(process.env.SESSION_TRANSFER_AUTO_RESUME);
        // newSession() has no model/thinking options. Queue the parent's values;
        // the child's fresh factory (active `pi`) applies them in session_start.
        pendingCarry = { model: ctx.model, thinking: pi.getThinkingLevel() };
        const seed = buildSeed(path, nextMode);
        const result = await ctx.newSession({
          parentSession: sessionFile,
          withSession: async (replaced) => {
            if (autoResume) {
              await replaced.sendUserMessage(seed);
            } else {
              await replaced.sendMessage(
                { customType: "session-transfer", content: seed, display: true },
                { triggerTurn: false },
              );
            }
          },
        });
        if (result.cancelled) {
          pendingCarry = null; // no child to consume it
          if (hasUI) ctx.ui.notify("session-transfer: rotation cancelled", "warning");
        }
      } catch (error) {
        pendingCarry = null;
        log(cwd, `rotation failed: ${String(error)}`);
        if (hasUI) ctx.ui.notify("session-transfer: rotation failed — see .pi/session-transfer.log", "error");
      }
    },
  });

  pi.registerTool({
    name: "begin_transfer",
    label: "Begin session transfer",
    description:
      "Start a session transfer now, while the user is present. Allowed once the context band is warn or above (usage ≥ 70% of the window); idle is not required. Moves the transfer to pending_docs and returns the instruction: author the handoff (hands-off) and session status (update-docs), then call request_transfer. Use when the injected context-budget guideline asks you to act, or when you judge the session is hot.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        if (!cfg.auto) {
          return textResult(
            "Automatic transfer is off. Use the /transfer command to package a handoff, or /transfer-resume to move. Set SESSION_TRANSFER_AUTO=1 to re-enable.",
            true,
          );
        }
        const usage = ctx.getContextUsage() as ContextUsageLike | undefined;
        const band = bandFor(usage, bandCfg);
        const guard = beginGuard(mem.state, cfg.disabled, band);
        if (!guard.ok) {
          const message =
            guard.reason === "disabled"
              ? "Session transfer is disabled (SESSION_TRANSFER_DISABLE)."
              : guard.reason === "busy"
                ? "A transfer is already in progress; ignoring begin_transfer."
                : "Not hot yet: context is below the warn band, so begin_transfer is a no-op.";
          return textResult(message, true);
        }
        mem = reduce(mem, { type: "trigger", channel: "agent" });
        log(ctx.cwd, "transfer started (channel=agent)");
        if (ctx.hasUI) ctx.ui.notify("session-transfer: agent transfer — writing handoff and status", "info");
        // Returned as the tool result so the agent acts in this same turn; do
        // NOT also sendUserMessage (that is reserved for /transfer + the gate).
        return textResult(transferPrompt(ctx.sessionManager.getSessionId()), false);
      } catch (error) {
        return textResult(`begin_transfer failed: ${String(error)}`, true);
      }
    },
  });

  pi.registerTool({
    name: "request_transfer",
    label: "Request session transfer",
    description:
      "Arm a session transfer once the handoff and session status are written. Call once with the handoff file path.",
    parameters: Type.Object({
      handoff_path: Type.String({ description: "Path to the handoff markdown file just written (relative to cwd or absolute)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (mem.state !== "pending_docs") {
        return textResult("No transfer is pending; ignoring request_transfer.", true);
      }
      const raw = String(params.handoff_path);
      const abs = isAbsolute(raw) ? raw : join(ctx.cwd, raw);
      if (!existsSync(abs)) return textResult(`Handoff not found: ${raw}`, true);
      const body = readFileSync(abs, "utf8");
      if (!body.trimStart().startsWith("---")) {
        return textResult("Handoff has no YAML frontmatter.", true);
      }
      mem = reduce(mem, { type: "docs_ready", path: abs });
      log(ctx.cwd, `armed from ${raw}`);
      return textResult(`Transfer armed from ${raw}. Non-explicit channels ask before rotating; /transfer-resume rotates immediately.`, false);
    },
  });
}

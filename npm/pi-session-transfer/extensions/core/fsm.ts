// session-transfer core — the transfer state machine. Pure: no pi imports, no I/O.
//
//   idle ──trigger──► pending_docs ──docs_ready──► armed ──rotation_dispatched──► idle
//                        │
//        user_message ───┴──► idle (human took over)
//        agent_settled  ──────► turnsInPending++ ; over budget ⇒ abort to idle
//
// Both entry channels (explicit /transfer, implicit gate+observer) converge on the
// same tail: pending_docs → armed → rotation.

export type TransferState = "idle" | "pending_docs" | "armed";
export type TransferChannel = "explicit" | "explicit_resume" | "implicit" | "agent";

export interface FsmMemory {
  state: TransferState;
  channel: TransferChannel | null;
  /** Absolute path to the handoff the agent produced, once armed. */
  handoffPath: string | null;
  /** Count of agent_settled while in pending_docs. */
  turnsInPending: number;
}

export const DEFAULT_DOCS_TURN_BUDGET = 4;

export const INITIAL_MEMORY: FsmMemory = {
  state: "idle",
  channel: null,
  handoffPath: null,
  turnsInPending: 0,
};

export type FsmEvent =
  | { type: "trigger"; channel: TransferChannel }
  | { type: "user_message" }
  | { type: "docs_ready"; path: string }
  | { type: "agent_settled" }
  | { type: "rotation_dispatched" };

export function reduce(
  mem: FsmMemory,
  event: FsmEvent,
  budget: number = DEFAULT_DOCS_TURN_BUDGET,
): FsmMemory {
  switch (event.type) {
    case "trigger":
      if (mem.state !== "idle") return mem;
      return { state: "pending_docs", channel: event.channel, handoffPath: null, turnsInPending: 0 };

    case "user_message":
      // The human spoke — they took over; abandon any in-flight transfer.
      if (mem.state === "idle") return mem;
      return { ...INITIAL_MEMORY };

    case "docs_ready":
      if (mem.state !== "pending_docs") return mem;
      return { ...mem, state: "armed", handoffPath: event.path };

    case "agent_settled": {
      if (mem.state !== "pending_docs") return mem;
      const turnsInPending = mem.turnsInPending + 1;
      if (turnsInPending >= budget) return { ...INITIAL_MEMORY }; // gave up; no rotation
      return { ...mem, turnsInPending };
    }

    case "rotation_dispatched":
      if (mem.state !== "armed") return mem;
      return { ...INITIAL_MEMORY };
  }
}

export function shouldRotate(mem: FsmMemory): boolean {
  return mem.state === "armed";
}

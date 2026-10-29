export type RalphAutonomyLevel =
  | "recommend"
  | "execute-with-review"
  | "execute-and-report"
  | "human-approval-required";

export type RalphPhase =
  | "define"
  | "explore"
  | "plan"
  | "tdd"
  | "verify"
  | "decide"
  | "human"
  | "done"
  | "aborted";

export type RalphDecision =
  | "done"
  | "retry"
  | "diagnose"
  | "human"
  | "abort"
  | "plan"
  | "explore"
  | "tdd";

export interface RalphIteration {
  runId: string;
  iteration: number;
  phase: RalphPhase;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  artifacts: string[];
  subagentSession: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface RalphState {
  runId: string;
  goal: string;
  targetProjectPath?: string;
  status: "running" | "paused" | "done" | "aborted";
  phase: RalphPhase;
  iteration: number;
  maxIterations: number;
  autoApprove: boolean;
  autonomyLevel: RalphAutonomyLevel;
  pauseRequested: boolean;
  activeSubagentSession: string | null;
  lastDecision: RalphDecision | null;
  commits: string[];
  artifacts: string[];
  acceptanceCriteria: string[];
  iterations: RalphIteration[];
  createdAt: string;
  updatedAt: string;
}

export interface VerifyResult {
  testsPassed: boolean;
  acceptanceMet: boolean;
  visualTestsPassed: boolean;
  visualTestsRun?: boolean;
  failures: string[];
  flags: string[];
  summary: string;
  liveTestFailed?: boolean;
  unclearCause?: boolean;
  structuralChange?: boolean;

  // Rich fields from video-backed-live-tester
  humanReviewNeeded?: boolean;
  severity?: "low" | "medium" | "high" | "none";
  category?: string;
  next_agent?: "coder" | "tester" | "diagnose" | "human" | "none";
  recommendations?: string[];
  evidence_links?: string[];
  behavioralMetrics?: Record<string, number | Record<string, number>>;
  videoReports?: Array<Record<string, unknown>>;
}

export interface TddMode {
  mode: "strict" | "medium" | "low";
  reason: string;
}

export interface RalphSettings {
  maxIterations?: number;
  pollIntervalMinutes?: number;
  stuckThresholdMinutes?: number;
}

export interface RalphRunOptions {
  goal?: string;
  prdPath?: string;
  targetProjectPath?: string;
  maxIterations?: number;
  autoApprove?: boolean;
  autonomyLevel?: RalphAutonomyLevel;
}

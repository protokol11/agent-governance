// propose.ts — the only writer in rule-lifecycle. Emits proposal markdown into
// cwd/.scratch/rule-lifecycle/<slug>.md and refuses any other path. The catalog
// is never opened for writing; proposals enter the normal review gates.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ReplayReport } from "./core/mine.ts";

export type ProposalKind = "candidate" | "promotion" | "demotion";

export interface Proposal {
  kind: ProposalKind;
  rule_id: string;
  provenance: string[];
  replay: ReplayReport | null;
  body?: string;
}

/** Write a proposal file under <root>/.scratch/rule-lifecycle and return its path. */
export function writeProposal(proposal: Proposal, { root = process.cwd() }: { root?: string } = {}): string {
  const dir = resolve(root, ".scratch", "rule-lifecycle");
  const slug = `${proposal.kind}-${slugify(proposal.rule_id)}`;
  const path = resolve(dir, `${slug}.md`);
  if (!path.startsWith(dir + sep)) {
    throw new Error(`refusing to write outside .scratch/rule-lifecycle: ${path}`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, render(proposal), "utf8");
  return path;
}

function render(proposal: Proposal): string {
  const provenance = proposal.provenance.map((id) => JSON.stringify(id)).join(", ");
  const lines = [
    "---",
    `kind: ${proposal.kind}`,
    `rule_id: ${JSON.stringify(proposal.rule_id)}`,
    `provenance: [${provenance}]`,
    proposal.replay
      ? `replay: {${proposal.kind === "promotion" ? "heldOutAccuracy" : "accuracy"}: ${proposal.replay.accuracy}, n: ${proposal.replay.n}}`
      : "replay: null",
    "---",
    "",
    `# ${proposal.kind}: ${proposal.rule_id}`,
    "",
    proposal.body ?? "Proposal mined from judgment-ledger evidence. Review through the normal gates.",
    "",
  ];
  return lines.join("\n");
}

function slugify(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return slug || "unnamed";
}

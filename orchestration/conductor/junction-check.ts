import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

const EXPECTED_EXTENSIONS = ["conductor"];

export interface JunctionCheckResult {
  name: string;
  link: string;
  target: string;
  expected: string;
  valid: boolean;
}

export async function checkJunctions(repoRoot: string): Promise<JunctionCheckResult[]> {
  const piAgentDir = join(homedir(), ".pi", "agent");
  const results: JunctionCheckResult[] = [];

  for (const name of EXPECTED_EXTENSIONS) {
    const link = join(piAgentDir, "extensions", name);
    const expected = normalize(join(repoRoot, ".pi", "extensions", name));

    let target = "";
    let valid = false;
    try {
      target = normalize(await realpath(link));
      valid = target.toLowerCase() === expected.toLowerCase();
    } catch {
      target = "missing";
      valid = false;
    }

    results.push({ name, link, target, expected, valid });
  }

  // Agents junction
  const agentsLink = join(piAgentDir, "agents");
  const agentsExpected = normalize(join(repoRoot, ".pi", "agents"));
  let agentsTarget = "";
  let agentsValid = false;
  try {
    agentsTarget = normalize(await realpath(agentsLink));
    agentsValid = agentsTarget.toLowerCase() === agentsExpected.toLowerCase();
  } catch {
    agentsTarget = "missing";
    agentsValid = false;
  }
  results.push({ name: "agents", link: agentsLink, target: agentsTarget, expected: agentsExpected, valid: agentsValid });

  return results;
}

export function formatJunctionWarning(results: JunctionCheckResult[]): string | null {
  const broken = results.filter((r) => !r.valid);
  if (broken.length === 0) return null;
  const lines = broken.map(
    (r) =>
      `  ${r.name}: ${r.link} points to ${r.target}, expected ${r.expected}`,
  );
  return "Junctions broken or missing:\n" + lines.join("\n") + "\nRun: .\\scripts\\install-junctions.ps1";
}

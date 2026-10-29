import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { countTokens, truncateToTokens } from "../../../tools/tokenizer/index.ts";

const CONDUCTOR_ARTIFACT_ROOT = "tmp/conductor";
const PROJECT_CONTEXT_FILE = ".pi/orchestrator-context.md";
const DEFAULT_CONTEXT_TOKEN_LIMIT = 2500;

interface Section {
  roles: string[];
  content: string;
}

function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  const lines = text.split("\n");
  let currentRoles: string[] = ["all"];
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*<!--\s*role:\s*([^>]+)--\>\s*$/i);
    if (match) {
      if (currentLines.length > 0) {
        sections.push({
          roles: currentRoles,
          content: currentLines.join("\n").trimEnd(),
        });
      }
      currentRoles = match[1]
        .split(",")
        .map((r) => r.trim().toLowerCase())
        .filter((r) => r.length > 0);
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      roles: currentRoles,
      content: currentLines.join("\n").trimEnd(),
    });
  }

  return sections;
}

function buildContextForRole(sections: Section[], role?: string): string {
  if (!role) {
    return sections.map((s) => s.content).join("\n\n").trim();
  }
  const targetRole = role.toLowerCase();
  const parts: string[] = [];
  for (const section of sections) {
    if (section.roles.includes("all") || section.roles.includes(targetRole)) {
      parts.push(section.content);
    }
  }
  return parts.join("\n\n").trim();
}

export async function loadProjectContext(cwd: string, role?: string): Promise<string> {
  const path = join(cwd, PROJECT_CONTEXT_FILE);
  if (!existsSync(path)) return "";
  const content = await readFile(path, "utf-8");
  const trimmed = content.trim();
  if (!trimmed) return "";

  const sections = parseSections(trimmed);
  const filtered = buildContextForRole(sections, role);
  if (!filtered) return "";

  const tokens = countTokens(filtered);
  if (tokens <= DEFAULT_CONTEXT_TOKEN_LIMIT) return filtered;

  return truncateToTokens(filtered, DEFAULT_CONTEXT_TOKEN_LIMIT);
}

export function artifactRoot(cwd: string, theme: string): string {
	return join(cwd, CONDUCTOR_ARTIFACT_ROOT, sanitizeSlug(theme));
}

export function artifactPath(cwd: string, theme: string, step: string, role: string): string {
	const stepFile = fileNameForStep(step, role);
	return join(artifactRoot(cwd, theme), stepFile);
}

export async function ensureArtifactDir(cwd: string, theme: string): Promise<void> {
	await mkdir(artifactRoot(cwd, theme), { recursive: true });
}

export function sanitizeSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9\-_]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function fileNameForStep(_step: string, role: string): string {
	switch (role) {
		case "explore":
			return "AUDIT.md";
		case "plan":
			return "plan.md";
		case "coder":
			return "code.md";
		case "tester":
			return "report.json";
		case "fixer":
			return "fix.md";
		default:
			return `${role}.md`;
	}
}

export function previousArtifactPath(cwd: string, theme: string, currentStepIndex: number, steps: string[]): string | undefined {
	if (currentStepIndex <= 0) return undefined;
	const prevRole = steps[currentStepIndex - 1];
	const prevStepIndex = currentStepIndex - 1;
	const prevStepName = prevRole;
	return artifactPath(cwd, theme, prevStepName, prevRole);
}

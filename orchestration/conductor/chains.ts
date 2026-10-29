import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChainsConfig, ChainDefinition } from "./types.ts";

declare const __dirname: string;

const PROJECT_CHAIN_FILE = ".pi/conductor-chains.json";

function getBaseChainFilePath(): string {
	// jiti compiles this file to CommonJS, so __dirname is available at runtime.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const extensionDir = typeof __dirname !== "undefined" ? __dirname : (globalThis as any).__dirname;
	// extensionDir = .../.pi/extensions/conductor
	// base chains live at .../.pi/conductor-chains.json
	return join(extensionDir, "..", "..", "conductor-chains.json");
}

async function readChainsFile(path: string): Promise<Record<string, string[]>> {
	const raw = await readFile(path, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || !("chains" in parsed)) {
		throw new Error(`Invalid chains config at ${path}: missing "chains"`);
	}
	const config = parsed as { chains: Record<string, string[]> };
	return config.chains;
}

export async function loadChains(cwd: string): Promise<ChainsConfig> {
	const basePath = getBaseChainFilePath();
	const baseChains = await readChainsFile(basePath);

	const projectPath = join(cwd, PROJECT_CHAIN_FILE);
	let projectChains: Record<string, string[]> = {};
	if (existsSync(projectPath)) {
		projectChains = await readChainsFile(projectPath);
	}

	return { chains: { ...baseChains, ...projectChains } };
}

export function getChain(config: ChainsConfig, name: string): ChainDefinition {
	const steps = config.chains[name];
	if (!steps) {
		throw new Error(`Unknown chain "${name}". Available: ${Object.keys(config.chains).join(", ")}`);
	}
	return { steps };
}

export function listChains(config: ChainsConfig): string[] {
	return Object.keys(config.chains);
}

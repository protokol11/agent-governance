// Тонкая pi-оболочка reconciler: команды, tool, session_start-хук.
// Вся логика — в core.ts/render.ts; здесь только регистрация и I/O-швы.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, classify } from './core.ts';
import { nodeFsAdapter } from './fs.ts';
import { renderStamp } from './render.ts';

const MANIFEST_REL = join('.agentic', 'manifest.json');
const CURRENT_RENDERER_VERSION = '1';

// session_start: read-only детект кандидатов. НИКОГДА не пишет файлы.
function checkSessionStart(ctx: ExtensionCommandContext): void {
  const manifestPath = join(ctx.cwd, MANIFEST_REL);
  if (!existsSync(manifestPath)) {
    ctx.ui.notify('setup-upgrade: manifest not found — setup candidate (run /setup-repo)', 'info');
    return;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = manifest?.renderer_version ?? '0';
    if (String(version) < CURRENT_RENDERER_VERSION) {
      ctx.ui.notify(`setup-upgrade: renderer ${version} < ${CURRENT_RENDERER_VERSION} — upgrade candidate (run /upgrade-repo)`, 'info');
    }
  } catch (err) {
    ctx.ui.notify(`setup-upgrade: manifest unreadable: ${(err as Error).message}`, 'warning');
  }
}

// /upgrade-repo: render x2 с проверкой детерминизма, классификация, печать diff.
// По умолчанию dry-run: ничего не пишет.
function upgradeRepoDryRun(ctx: ExtensionCommandContext): string {
  const fs = nodeFsAdapter();
  const rendered = renderStamp();
  const manifest = buildManifest(rendered, { rendererVersion: CURRENT_RENDERER_VERSION });
  const onDisk: Record<string, string> = {};
  for (const path of Object.keys(manifest.entries)) {
    const abs = join(ctx.cwd, path);
    const content = fs.read(abs);
    if (content !== null) onDisk[path] = content;
  }
  const verdicts = classify(manifest, onDisk);
  const lines = Object.entries(verdicts).map(([p, v]) => `${v.padEnd(13)} ${p}`);
  return [`upgrade-repo (dry-run, 0 writes):`, ...lines].join('\n');
}

export default function setupUpgrade(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx: ExtensionCommandContext) => {
    try {
      checkSessionStart(ctx);
    } catch {
      // fail-soft: хук не должен ломать старт сессии
    }
  });

  pi.registerCommand('setup-repo', {
    description: 'Scaffold repo from principles-render stamp (dry-run diff first; writes only via manifest paths)',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(upgradeRepoDryRun(ctx), 'info');
    },
  });

  pi.registerCommand('upgrade-repo', {
    description: 'Reconcile repo with rendered stamp; dry-run diff, 0 writes by default',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(upgradeRepoDryRun(ctx), 'info');
    },
  });

  pi.registerTool({
    name: 'setup_repo',
    label: 'Setup repo scaffold',
    description: 'Dry-run classify of cwd against rendered stamp; no writes',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionCommandContext) {
      return { content: [{ type: 'text', text: upgradeRepoDryRun(ctx) }], details: {} };
    },
  });

  pi.registerTool({
    name: 'upgrade_repo',
    label: 'Upgrade repo scaffold',
    description: 'Dry-run classify of cwd against rendered stamp; no writes',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx: ExtensionCommandContext) {
      return { content: [{ type: 'text', text: upgradeRepoDryRun(ctx) }], details: {} };
    },
  });
}

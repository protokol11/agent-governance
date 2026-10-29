// Рендер штампа через внешний principles-render и проверка детерминизма.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { identityHash } from './core.ts';

const RENDERER = 'C:\\Users\\HOME\\.agents\\skills\\principles-render\\render.mjs';

function readTree(dir: string, base: string = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, readTree(full, base));
    else out[relative(base, full).replace(/\\/g, '/')] = readFileSync(full, 'utf8');
  }
  return out;
}

function renderOnce(outDir: string, renderer: string): Record<string, string> {
  execFileSync('node', [renderer, '--out', outDir], { stdio: 'pipe' });
  return readTree(outDir);
}

// Рендерит штамп дважды во временные каталоги и сверяет normalized-hash.
// Расхождение → throw: недетерминированный рендер отвергнут.
export function renderStamp(opts: { renderer?: string } = {}): Record<string, string> {
  const renderer = opts.renderer ?? RENDERER;
  const dirA = mkdtempSync(join(tmpdir(), 'stamp-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'stamp-b-'));
  try {
    const treeA = renderOnce(dirA, renderer);
    const treeB = renderOnce(dirB, renderer);
    const keysA = Object.keys(treeA).sort().join('\n');
    const keysB = Object.keys(treeB).sort().join('\n');
    if (keysA !== keysB) {
      throw new Error(`render non-deterministic: file sets differ (${keysA} vs ${keysB})`);
    }
    for (const path of Object.keys(treeA)) {
      if (identityHash(treeA[path]) !== identityHash(treeB[path])) {
        throw new Error(`render non-deterministic: content differs at ${path}`);
      }
    }
    return treeA;
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}


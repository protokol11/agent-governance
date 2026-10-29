// Файловые адаптеры: реальный node fs и in-memory для тестов.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileSystemAdapter } from './types.ts';

export function nodeFsAdapter(): FileSystemAdapter {
  return {
    read(path) {
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf8');
    },
    write(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    },
    delete(path) {
      rmSync(path, { force: true });
    },
    exists(path) {
      return existsSync(path);
    },
    list(dir) {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(dir, e.name));
    },
  };
}

export function memoryFsAdapter(initial: Record<string, string> = {}): FileSystemAdapter & {
  snapshot(): Record<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    read(path) {
      return store.has(path) ? (store.get(path) as string) : null;
    },
    write(path, content) {
      store.set(path, content);
    },
    delete(path) {
      store.delete(path);
    },
    exists(path) {
      return store.has(path);
    },
    list(dir) {
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    snapshot() {
      return Object.fromEntries(store);
    },
  };
}

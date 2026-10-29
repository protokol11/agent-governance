// core/hash.ts — stable FNV-1a hash of the state for the ledger.
export function hashState(state: unknown): string {
  const s = JSON.stringify(state);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** One line of a unified diff. */
export interface DiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
}

/** Above this many lines per side the LCS table gets expensive; fall back to "all removed, all added". */
const MAX_LINES = 2000;

/**
 * A minimal line diff (longest common subsequence) for review views — e.g. the
 * Dockerfile of a plugin version against the previous approved one. `null`
 * sides are treated as empty.
 */
export function diffLines(previous: string | null, current: string | null): DiffLine[] {
  const a = previous ? previous.split('\n') : [];
  const b = current ? current.split('\n') : [];
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))];
  }
  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: 'del', text: a[i] }); i += 1; }
    else { out.push({ op: 'add', text: b[j] }); j += 1; }
  }
  while (i < a.length) { out.push({ op: 'del', text: a[i] }); i += 1; }
  while (j < b.length) { out.push({ op: 'add', text: b[j] }); j += 1; }
  return out;
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified diffs for remediation: the stored `remediation.diff` (what a reviewer
 * approves), the Official `export.diff` (re-rooted at deploy/plugins/<name>/),
 * the changed-line list the diff-scope check reads, and applying a drafted patch
 * (the ask-agent fallback). Pure.
 */

export type FileMap = ReadonlyMap<string, string>;

interface Op { kind: ' ' | '-' | '+'; text: string }

const CONTEXT = 3;
/** Above this many LCS cells the middle is diffed as one replace block (lockfiles). */
const MAX_LCS_CELLS = 4_000_000;

function lineOps(a: readonly string[], b: readonly string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((text) => ({ kind: ' ', text }));
  if (am.length * bm.length > MAX_LCS_CELLS) {
    for (const text of am) ops.push({ kind: '-', text });
    for (const text of bm) ops.push({ kind: '+', text });
  } else {
    const n = am.length;
    const m = bm.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ kind: ' ', text: am[i]! }); i++; j++; } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { ops.push({ kind: '-', text: am[i]! }); i++; } else { ops.push({ kind: '+', text: bm[j]! }); j++; }
    }
    while (i < n) ops.push({ kind: '-', text: am[i++]! });
    while (j < m) ops.push({ kind: '+', text: bm[j++]! });
  }
  for (const text of a.slice(a.length - suf)) ops.push({ kind: ' ', text });
  return ops;
}

const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/** One file's unified diff (empty string when unchanged). `before` null = a new file. */
export function fileDiff(path: string, before: string | null, after: string | null, root = ''): string {
  if (before === after) return '';
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const ops = lineOps(a, b);
  const out: string[] = [`--- ${before === null ? '/dev/null' : `a/${root}${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${root}${path}`}`];
  // Group changes into hunks with CONTEXT lines around them.
  const changed = ops.map((o, i) => (o.kind !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (changed.length === 0) return '';
  let start = 0;
  while (start < changed.length) {
    let end = start;
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= CONTEXT * 2) end++;
    const from = Math.max(0, changed[start]! - CONTEXT);
    const to = Math.min(ops.length - 1, changed[end]! + CONTEXT);
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < from; k++) { if (ops[k]!.kind !== '+') aLine++; if (ops[k]!.kind !== '-') bLine++; }
    const body = ops.slice(from, to + 1);
    const aCount = body.filter((o) => o.kind !== '+').length;
    const bCount = body.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${aCount === 0 ? aLine - 1 : aLine},${aCount} +${bCount === 0 ? bLine - 1 : bLine},${bCount} @@`);
    for (const o of body) out.push(`${o.kind}${o.text}`);
    start = end + 1;
  }
  return `${out.join('\n')}\n`;
}

/** The unified diff of every file that differs between two trees (sorted by path). */
export function treeDiff(before: FileMap, after: FileMap, root = ''): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((p) => fileDiff(p, before.get(p) ?? null, after.get(p) ?? null, root)).join('');
}

/** The lines a change removed and added, per file (the diff-scope check's input). */
export function changedLines(before: string | null, after: string | null): { removed: string[]; added: string[] } {
  const ops = lineOps(splitLines(before ?? ''), splitLines(after ?? ''));
  return { removed: ops.filter((o) => o.kind === '-').map((o) => o.text), added: ops.filter((o) => o.kind === '+').map((o) => o.text) };
}

// -- applying a patch ---------------------------------------------------------------

export class PatchApplyError extends Error {
  readonly code = 'PATCH_DOES_NOT_APPLY';
  constructor(message: string) { super(message); this.name = 'PatchApplyError'; }
}

interface Hunk { aStart: number; lines: string[] }
interface FilePatch { from: string | null; to: string | null; hunks: Hunk[] }

const stripPrefix = (p: string): string | null => (p === '/dev/null' ? null : p.replace(/^[ab]\//, '').split('\t')[0]!);

function parsePatch(diff: string): FilePatch[] {
  const files: FilePatch[] = [];
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  let cur: FilePatch | null = null;
  let hunk: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      cur = { from: stripPrefix(line.slice(4).trim()), to: stripPrefix(lines[i + 1]!.slice(4).trim()), hunks: [] };
      files.push(cur);
      hunk = null;
      i++;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (h) {
      if (!cur) throw new PatchApplyError('hunk before a file header');
      hunk = { aStart: Number(h[1]), lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk && (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+'))) hunk.lines.push(line);
  }
  return files;
}

/**
 * Apply a unified diff to a tree. Each hunk's context must match exactly (at
 * its line, or the nearest offset); paths must stay inside the tree (no `..`,
 * no absolute). Returns the new tree; throws {@link PatchApplyError}.
 */
export function applyPatch(tree: FileMap, diff: string): Map<string, string> {
  const out = new Map(tree);
  const patches = parsePatch(diff);
  if (patches.length === 0) throw new PatchApplyError('no file in the patch');
  for (const fp of patches) {
    const path = fp.to ?? fp.from;
    if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new PatchApplyError('patch path outside the build context');
    if (fp.to === null) { out.delete(path); continue; }
    let lines = fp.from === null ? [] : splitLines(out.get(fp.from) ?? (() => { throw new PatchApplyError(`no such file: ${fp.from}`); })());
    let shift = 0;
    for (const h of fp.hunks) {
      const oldLines = h.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1));
      const newLines = h.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
      const want = Math.max(0, h.aStart - 1 + shift);
      let at = -1;
      for (let d = 0; d <= lines.length && at < 0; d++) {
        for (const pos of d === 0 ? [want] : [want - d, want + d]) {
          if (pos < 0 || pos + oldLines.length > lines.length) continue;
          if (oldLines.every((l, k) => lines[pos + k] === l)) { at = pos; break; }
        }
      }
      if (at < 0) throw new PatchApplyError(`hunk does not apply to ${path}`);
      lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at + oldLines.length)];
      shift += newLines.length - oldLines.length + (at - want);
    }
    out.set(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  }
  return out;
}

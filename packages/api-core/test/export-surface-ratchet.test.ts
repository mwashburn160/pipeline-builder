// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A ratchet on the size of the repo's exported surface.
 *
 * A symbol that is `export`ed but used only inside its own file is not a runtime problem —
 * nothing breaks, nothing ships that should not. What it costs is REFACTORING: every
 * exported name has to be treated as something a caller might depend on, so an internal
 * helper that was never internal cannot be renamed, narrowed or deleted without a search
 * across four trees. It also hides genuinely dead code, because "exported" reads as
 * "someone probably uses it".
 *
 * WHY A RATCHET AND NOT A LINT RULE. `import/no-unused-modules` detects exactly this, and
 * turning it on would emit ~240 warnings on day one — at which point warning 241, the one
 * that matters, is invisible. A single number cannot be drowned: the existing surface is
 * grandfathered, and anything NEW fails. Fix some and lower the number; the direction is
 * one-way by construction.
 *
 * WHY ONLY RUNTIME DECLARATIONS. `interface` and `type` exports are excluded (there are
 * ~680 of them). A type costs nothing at runtime and exporting one is often deliberate —
 * it documents a shape a reader wants to name even when only this file constructs it.
 * Ratcheting them would be busywork that teaches people to fight the guard.
 *
 * NOT counted here: a symbol referenced NOWHERE AT ALL, including its own file. That is
 * dead code rather than an over-wide surface, and it is a different (smaller, sharper)
 * problem — see the cleanup that removed the last batch.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';

/** Repo root, from `packages/api-core`. */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * The agreed ceiling: THIS detector's own count on 2026-09-28, with no slack.
 *
 * Set from the number below rather than from a separate script that measured a different
 * corpus — the first attempt used a `git ls-files` count of 242 against a walker that sees
 * 220, and the 22 of slack meant a deliberately planted over-export passed unnoticed. A
 * ceiling with room in it is not a ratchet.
 *
 * Lower it when you remove some; never raise it. If a change needs to raise it, the export
 * is either genuinely used from another file (then this guard will not count it) or it
 * should not be exported.
 */
const MAX_RUNTIME_OVER_EXPORTS = 220;

const DECL = /^export\s+(?:async\s+)?(?:declare\s+)?(function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/;
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** The four trees this repo owns. */
function trees(): string[] {
  const out = [join(REPO_ROOT, 'platform'), join(REPO_ROOT, 'frontend')];
  for (const group of ['api', 'packages']) {
    const dir = join(REPO_ROOT, group);
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) out.push(full);
      } catch { /* not a directory */ }
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * A package's public entry is its API by definition, so a name declared there is never
 * "over-exported". Test helpers likewise exist to be imported from outside.
 */
function isPublicEntry(file: string): boolean {
  return /\/src\/index\.tsx?$/.test(file) || /\/src\/api\/index\.ts$/.test(file) || file.includes('/testing/');
}

interface Finding { kind: string; file: string; name: string }

function overExported(): Finding[] {
  const files: string[] = [];
  for (const tree of trees()) {
    try { walk(tree, files); } catch { /* tree absent */ }
  }
  const source = files.filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes('/test/'));

  // Where each name is declared, and on which line (so the declaration itself is not
  // mistaken for a use).
  const declaredIn = new Map<string, string[]>();
  const kindOf = new Map<string, string>();
  const declLine = new Map<string, number>();
  for (const file of source) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = DECL.exec(line);
      if (!m) return;
      const [, kind, name] = m as unknown as [string, string, string];
      declaredIn.set(name, [...(declaredIn.get(name) ?? []), file]);
      kindOf.set(name, kind);
      declLine.set(`${file}\0${name}`, i);
    });
  }

  // One pass over EVERY file (tests included: a test importing it is a real caller).
  const seenIn = new Map<string, Set<string>>();
  const usesInOwnFile = new Map<string, number>();
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const namesHere = new Set<string>();
    lines.forEach((line, i) => {
      for (const tok of line.match(IDENT) ?? []) {
        if (!declaredIn.has(tok)) continue;
        namesHere.add(tok);
        if (declLine.get(`${file}\0${tok}`) === i) continue;
        usesInOwnFile.set(`${file}\0${tok}`, (usesInOwnFile.get(`${file}\0${tok}`) ?? 0) + 1);
      }
    });
    for (const name of namesHere) {
      seenIn.set(name, (seenIn.get(name) ?? new Set()).add(file));
    }
  }

  const findings: Finding[] = [];
  for (const [name, decls] of declaredIn) {
    // Declared in two files: ambiguous by name alone, so not counted either way.
    if (decls.length !== 1) continue;
    const file = decls[0]!;
    if (isPublicEntry(file)) continue;
    const elsewhere = [...(seenIn.get(name) ?? [])].filter((f) => f !== file);
    if (elsewhere.length > 0) continue; // really used
    if ((usesInOwnFile.get(`${file}\0${name}`) ?? 0) === 0) continue; // dead, not over-wide
    findings.push({ kind: kindOf.get(name)!, file: file.slice(REPO_ROOT.length + 1), name });
  }
  return findings;
}

describe('the exported surface does not grow', () => {
  const findings = overExported();

  it('finds over-exports at all (guards the guard)', () => {
    // A broken walk or regex would report zero and the ceiling would pass forever.
    expect(findings.length).toBeGreaterThan(100);
  });

  it(`has at most ${MAX_RUNTIME_OVER_EXPORTS} runtime symbols exported but used only in their own file`, () => {
    const byArea = new Map<string, number>();
    for (const f of findings) {
      const area = f.file.split('/').slice(0, 2).join('/');
      byArea.set(area, (byArea.get(area) ?? 0) + 1);
    }
    expect({
      count: findings.length,
      ceiling: MAX_RUNTIME_OVER_EXPORTS,
      overBy: Math.max(0, findings.length - MAX_RUNTIME_OVER_EXPORTS),
      byArea: Object.fromEntries([...byArea].sort((a, b) => b[1] - a[1])),
      fix: 'A symbol here is `export`ed but referenced only inside its own file, so the export '
        + 'widens a package API for no caller. Drop the `export` keyword. If it IS used from '
        + 'another file, this guard will not count it — check the spelling. Lower '
        + 'MAX_RUNTIME_OVER_EXPORTS when you remove some; never raise it.\n'
        + 'MID-REFACTOR? This is expected and transient. The ceiling has NO slack by design, '
        + 'so extracting a shared module counts its exports the moment the file exists and '
        + 'stops counting them once a second file imports it. Finish the wiring and re-run '
        + 'before concluding anything is wrong.',
    }).toMatchObject({ overBy: 0 });
  });
});

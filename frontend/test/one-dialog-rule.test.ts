// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-dialog rule, pinned.
 *
 * Three confirmation primitives are in parallel use, and that is fine — they
 * answer different questions:
 *
 *   - `StepUpModal`  — a destructive action the SERVER step-up gates. It IS the
 *     confirmation: it takes `title` + `details` (what is lost) and the factor
 *     in one place.
 *   - `ConfirmDialog` — a consequential action the server does NOT step-up gate
 *     (discard unsaved edits, deactivate a member, confirm a charge, revoke a
 *     key — deliberately un-gated so a compromised key is always killable).
 *   - `DeleteConfirmModal` — the plain "delete <name>, this cannot be undone"
 *     shape, for deletes with no step-up.
 *
 * What is NOT fine is chaining two of them for ONE action: a confirm dialog
 * whose Confirm opens a step-up dialog asks the same person the same question
 * twice and teaches them to click through both without reading either. That is
 * the rule `pages/dashboard/settings.tsx` states for "Delete your account" and
 * `StepUpModal`'s own doc comment spells out; two surfaces broke it
 * (`TeamsCard` team delete, Members ownership transfer) until this test landed.
 *
 * Detected mechanically, in both shapes the chain takes:
 *   1. an inline handler — `onConfirm={() => setPendingX(row)}`, and
 *   2. a named handler — `onConfirm={confirmX}` where `confirmX` calls
 *      `setPendingX`,
 * where `pendingX` is what guards a `<StepUpModal>` in the same file.
 */
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FRONTEND_DIR = resolve(__dirname, '..');
const CONFIRM_PRIMITIVES = ['ConfirmDialog', 'DeleteConfirmModal'] as const;

/** Every .ts/.tsx source under pages/ and src/, relative to the frontend root. */
function sourceFiles(dir = '', roots = ['pages', 'src']): string[] {
  if (!dir) return roots.flatMap((r) => sourceFiles(r, roots));
  return readdirSync(resolve(FRONTEND_DIR, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sourceFiles(rel, roots);
    return e.name.endsWith('.tsx') || e.name.endsWith('.ts') ? [rel] : [];
  });
}

/** `setPendingDelete` for `pendingDelete`. */
const setterFor = (guard: string) => `set${guard[0].toUpperCase()}${guard.slice(1)}`;

/**
 * The OPENING tag of every `<Primitive …>` in `src` — props only, bounded at
 * the `>` / `/>` that ends it. Bounding matters: a self-closing primitive
 * followed by the `<StepUpModal>` it chains into would otherwise be read as one
 * blob and every such pair would look like a hit for the wrong reason.
 */
function openingTags(src: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`<${tag}[\\s/>]`, 'g'))) {
    const from = m.index ?? 0;
    let depth = 0;
    for (let i = from; i < src.length; i += 1) {
      const c = src[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) { out.push(src.slice(from, i + 1)); break; }
    }
  }
  return out;
}

/** The declaration of `const name = …` / `function name(…)`, if present. */
function declarationOf(src: string, name: string): string {
  const at = new RegExp(`(?:const\\s+${name}\\s*=|function\\s+${name}\\s*\\()`).exec(src);
  // Declarations in this codebase are short; a fixed window sees the call
  // without reading a LATER declaration's statements as part of this one.
  return at ? src.slice(at.index, at.index + 800) : '';
}

describe('a destructive step-up action is ONE dialog', () => {
  const files = sourceFiles();

  it('finds sources to check (the scan is not empty)', () => {
    expect(files.length).toBeGreaterThan(200);
    // And the rule has something to be about: StepUpModal is widely rendered.
    const withStepUp = files.filter((f) => readFileSync(resolve(FRONTEND_DIR, f), 'utf8').includes('<StepUpModal'));
    expect(withStepUp.length).toBeGreaterThan(20);
  });

  it('no confirm dialog opens a step-up dialog for the same action', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(resolve(FRONTEND_DIR, file), 'utf8');
      if (!src.includes('<StepUpModal')) continue;
      // What each StepUpModal in this file is conditioned on.
      const guards = [...src.matchAll(/\{\s*(\w+)\s*&&\s*\(?\s*<StepUpModal/g)].map((m) => m[1]);
      if (guards.length === 0) continue;

      for (const primitive of CONFIRM_PRIMITIVES) {
        for (const tag of openingTags(src, primitive)) {
          // `onConfirm={…}` reaches the setter directly (an inline arrow) or
          // through what it names — `confirmTransfer`, or `del.confirm`, whose
          // `useDelete` callback is where the chain really lives.
          const handler = /onConfirm=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/.exec(tag)?.[1] ?? '';
          const reach = [tag, ...[...handler.matchAll(/\b([A-Za-z_]\w*)/g)]
            .map((m) => declarationOf(src, m[1]))].join('\n');
          for (const guard of guards) {
            if (reach.includes(`${setterFor(guard)}(`)) {
              offenders.push(`${file}: <${primitive}> opens the <StepUpModal> guarded by \`${guard}\``);
            }
          }
        }
      }
    }

    expect({
      offenders,
      fix: 'A destructive, step-up-gated action must be ONE dialog: drop the ConfirmDialog / '
        + 'DeleteConfirmModal and pass its heading and its "what is lost" copy to StepUpModal as '
        + '`title` and `details`. See pages/dashboard/settings.tsx ("Delete your account").',
    }).toEqual({ offenders: [], fix: expect.any(String) });
  });

  it('the surfaces that used to chain two dialogs now pass `details` to the step-up', () => {
    // The two this rule was written for. A regression that merely renamed the
    // state would satisfy the scan above; these assert the copy survived.
    const teams = readFileSync(resolve(FRONTEND_DIR, 'src/components/teams/TeamsCard.tsx'), 'utf8');
    expect(teams).not.toContain('<ConfirmDialog');
    expect(teams).toMatch(/details=\{[\s\S]*Recently deleted teams/);

    const members = readFileSync(resolve(FRONTEND_DIR, 'pages/dashboard/members.tsx'), 'utf8');
    expect(members).toMatch(/details=\{[\s\S]*demoted to admin/);
  });
});

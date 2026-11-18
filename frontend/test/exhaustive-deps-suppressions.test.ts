// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `react-hooks/exhaustive-deps` suppressions, pinned.
 *
 * There were 43. Each one hid a dependency the effect / memo / callback really
 * read, and the reasons given ("router identity changes each render", "params
 * tracked via key", "callbacks are stable") were the kind that stop being true
 * without anyone noticing — the shape stale-closure bugs come from. They were
 * all removed in favour of honest dependency lists, using:
 *
 *  - React's `useEffectEvent` — logic an effect calls but that must not
 *    re-trigger it (a router write, a parent's callback, a one-shot seed);
 *  - `useEventCallback` (src/hooks/useLatest.ts) — a stable callback for a
 *    memoised column builder or a URL setter, always running the newest closure;
 *  - `useKeyedValue` / `useStableDeps` — an object or dep list rebuilt each
 *    render, held stable while its key / elements are unchanged.
 *
 * This test keeps the count from growing back:
 *
 *  1. a file may carry a suppression only if it is on {@link ALLOWED} — with
 *     at most that many, each with a same-line `-- reason`;
 *  2. the allowlist may only SHRINK (a stale entry fails), and it is empty
 *     today. Never add one without a justification nothing above can express;
 *  3. a disable with no rule list (which silences every rule, this one
 *     included) is not allowed anywhere;
 *  4. the rule stays an ERROR in the generated eslint config.
 */
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FRONTEND_DIR = resolve(__dirname, '..');

/** Generated code is not hand-written and not linted for this. */
const SKIP_DIRS = new Set(['src/generated', 'src/lib/help/generated']);

/**
 * File → { count, reason } for suppressions that must genuinely remain.
 * MAY ONLY SHRINK. Empty: every suppression was removed.
 */
const ALLOWED: ReadonlyMap<string, { count: number; reason: string }> = new Map([]);

/** An eslint directive comment that names the rule. */
const SUPPRESSION = /eslint-disable(?:-next-line|-line)?\b[^\n]*react-hooks\/exhaustive-deps[^\n]*/g;
/** A directive with NO rule list — silences everything, this rule included. */
const BARE_DISABLE = /eslint-disable(?:-next-line|-line)?[ \t]*(?:\*\/|--|$)/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(FRONTEND_DIR, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return SKIP_DIRS.has(rel) ? [] : sourceFiles(rel);
    return /\.(?:ts|tsx|js|jsx)$/.test(e.name) ? [rel] : [];
  });
}

const FILES = ['src', 'pages'].flatMap(sourceFiles);

function scan(re: RegExp): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of FILES) {
    const hits = [...readFileSync(resolve(FRONTEND_DIR, file), 'utf8').matchAll(re)].map((m) => m[0].trim());
    if (hits.length) out.set(file, hits);
  }
  return out;
}

describe('react-hooks/exhaustive-deps suppressions', () => {
  const found = scan(SUPPRESSION);

  it('scans the real tree (sanity)', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('src/hooks/useLatest.ts');
  });

  it('no file suppresses the rule beyond its allowlisted count', () => {
    const offenders = [...found]
      .filter(([f, hits]) => hits.length > (ALLOWED.get(f)?.count ?? 0))
      .map(([f, hits]) => `${f}: ${hits.length} (allowed ${ALLOWED.get(f)?.count ?? 0}) — use useEffectEvent / useEventCallback / useKeyedValue instead`);
    expect(offenders).toEqual([]);
  });

  it('the total never exceeds the allowlist', () => {
    const total = [...found.values()].reduce((n, h) => n + h.length, 0);
    const allowed = [...ALLOWED.values()].reduce((n, a) => n + a.count, 0);
    expect(total).toBeLessThanOrEqual(allowed);
  });

  it('every remaining suppression carries a same-line `-- reason`', () => {
    const bare = [...found].flatMap(([f, hits]) => hits.filter((h) => !/--\s*\S/.test(h)).map((h) => `${f}: ${h}`));
    expect(bare).toEqual([]);
  });

  it('the allowlist only lists files that still need it (delete fixed entries)', () => {
    const stale = [...ALLOWED].filter(([f, a]) => (found.get(f)?.length ?? 0) < a.count).map(([f]) => f);
    expect(stale).toEqual([]);
    for (const { reason } of ALLOWED.values()) expect(reason.trim().length).toBeGreaterThan(20);
  });

  it('no file uses a rule-less eslint-disable (it would silence this rule too)', () => {
    expect([...scan(BARE_DISABLE)].map(([f]) => f)).toEqual([]);
  });

  it('the rule is an ERROR in the frontend eslint config', () => {
    const config = JSON.parse(
      readFileSync(resolve(FRONTEND_DIR, '.eslintrc.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { rules: Record<string, unknown> };
    expect(config.rules['react-hooks/exhaustive-deps']).toBe('error');
  });

  it('the detector recognises the shapes it is meant to catch', () => {
    const sample = [
      '    // eslint-disable-next-line react-hooks/exhaustive-deps -- reason',
      '  }, [a]); // eslint-disable-line react-hooks/exhaustive-deps',
      '/* eslint-disable react-hooks/exhaustive-deps */',
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps',
      '// eslint-disable-next-line react-hooks/rules-of-hooks',
    ].join('\n');
    expect([...sample.matchAll(SUPPRESSION)]).toHaveLength(4);
    expect([...'// eslint-disable-next-line\n/* eslint-disable */\n// eslint-disable-line -- x'.matchAll(BARE_DISABLE)]).toHaveLength(3);
    expect([...'// eslint-disable-next-line no-console'.matchAll(BARE_DISABLE)]).toHaveLength(0);
  });
});

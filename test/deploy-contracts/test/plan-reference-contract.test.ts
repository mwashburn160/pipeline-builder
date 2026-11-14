// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plans are temporary. A design plan under docs/plans/ is deleted once its work
 * ships, so anything that points INTO a plan rots the day it is deleted. This
 * happened three times: the expansion-offers, CPU-credits and toolchain-release
 * plans left about 80 links to missing files and 230 decision labels that no
 * reader could look up.
 *
 * So code, config and the permanent docs cite the permanent docs, never a plan.
 * The reasoning a reader needs goes into the comment itself, or into a doc
 * outside docs/plans/. This suite fails on:
 *
 *  - a link to a docs/plans/ file that does not exist;
 *  - a plan's decision label (`(D6)`, `D14's`, `plan D9`, `plan §2`) anywhere
 *    outside docs/plans/.
 */

import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { extname, join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT, read } from '../src/index.js';

const SELF = 'test/deploy-contracts/test/plan-reference-contract.test.ts';

/** Text files a person reads: source, config, scripts and docs. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.sql', '.yml', '.yaml', '.md', '.py', '.alloy', '.conf', '.tf', '',
]);

/** Tracked + untracked repo files, minus .gitignore'd output, node_modules and generated help. */
function repoTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((f) => f && f !== SELF)
    .filter((f) => !f.split('/').includes('node_modules'))
    // Generated from docs/ by `npm run generate:help`; the docs themselves are checked.
    .filter((f) => !f.startsWith('frontend/src/lib/help/generated/'))
    .filter((f) => TEXT_EXTENSIONS.has(extname(f)))
    .filter((f) => {
      const abs = join(REPO_ROOT, f);
      return existsSync(abs) && statSync(abs).isFile() && statSync(abs).size <= 8 * 1024 * 1024;
    });
}

/** Every `file:line: text` in `files` whose line matches `pattern`. */
function hits(files: string[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (pattern.test(line)) out.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return out;
}

describe('references into docs/plans/', () => {
  const files = repoTextFiles();

  it('every link to a plan file names one that exists', () => {
    // `docs/plans/x.md` from anywhere, or `plans/x.md` from a doc under docs/.
    const link = new RegExp('(?:docs/)?plans/([a-z0-9][a-z0-9-]*)\\.md', 'g');
    const dangling: string[] = [];
    for (const f of files) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(link)) {
          if (!existsSync(join(REPO_ROOT, 'docs', 'plans', `${m[1]}.md`))) {
            dangling.push(`${f}:${i + 1}: ${m[0]}`);
          }
        }
      });
    }
    expect(dangling).toEqual([]);
  });

  it('no plan decision labels outside docs/plans/ (cite a permanent doc, or say the rule)', () => {
    const outsidePlans = files.filter((f) => !f.startsWith('docs/plans/'));
    // `(D6)`, `(D11/D13)`, `(D4 Class 3)`, `D6's`, `plan D9`, `plan §2` — built
    // by concatenation so this file's own text never matches.
    const label = new RegExp([
      '\\(' + 'D\\d{1,2}(?:[ /,;][^)]*)?\\)',
      '(?<![A-Za-z0-9_])' + 'D\\d{1,2}\'s',
      'plan ' + '(?:D\\d|§\\d)',
    ].join('|'));
    expect(hits(outsidePlans, label)).toEqual([]);
  });
});

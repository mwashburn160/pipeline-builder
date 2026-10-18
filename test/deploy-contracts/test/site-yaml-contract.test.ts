// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The site's YAML must parse — `_config.yml` and every page's front matter.
 *
 * Nothing in the build reads these files, so a syntax error in them survives a
 * green `nx run-many -t build --all` and only surfaces when GitHub Pages tries
 * to deploy:
 *
 *   Error: (/github/workspace/./_config.yml): mapping values are not allowed
 *   in this context at line 2 column 88
 *
 * The cause was an unquoted scalar containing a colon-space. This is the single
 * easiest way to break Jekyll, because the text reads perfectly well to a human:
 *
 *   description: ... software factories on AWS: complete DevSecOps ...
 *                                             ^^ YAML reads this as a nested
 *                                                mapping and refuses the file
 *
 * Any description, title or tagline is liable to acquire a colon the next time
 * someone edits the copy, so the rule is checked rather than remembered. A
 * value containing `: ` must be quoted, or written as a `>`/`|` block.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { parse } from 'yaml';
import { REPO_ROOT } from '../src/index.js';

/** Markdown pages Jekyll renders: the repo root and docs/. */
function pages(): string[] {
  const out: string[] = [];
  for (const dir of ['', 'docs']) {
    const abs = dir ? join(REPO_ROOT, dir) : REPO_ROOT;
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.md')) out.push(dir ? `${dir}/${f}` : f);
    }
  }
  return out.sort();
}

/** The front-matter block of a page, or null when it has none. */
function frontMatter(rel: string): string | null {
  const t = readFileSync(join(REPO_ROOT, rel), 'utf-8');
  const m = /^---\n([\s\S]*?)\n---/.exec(t);
  return m ? m[1] : null;
}

describe('site YAML', () => {
  const withFm = pages().filter((p) => frontMatter(p) !== null);

  it('finds the pages to check (guards a vacuous pass)', () => {
    expect(withFm.length).toBeGreaterThanOrEqual(10);
    expect(withFm).toContain('index.md');
  });

  it('parses _config.yml', () => {
    // The file that broke the deploy. Parsing it IS the assertion.
    const cfg = parse(readFileSync(join(REPO_ROOT, '_config.yml'), 'utf-8')) as Record<string, unknown>;
    expect(typeof cfg.title).toBe('string');
    expect(typeof cfg.description).toBe('string');
  });

  it('parses every page\'s front matter', () => {
    const broken: string[] = [];
    for (const p of withFm) {
      try {
        parse(frontMatter(p)!);
      } catch (e) {
        broken.push(`${p}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('quotes any value containing a colon-space', () => {
    // Catches the mistake BEFORE it becomes a parse error, including in files
    // a looser parser might still accept.
    const unquoted: string[] = [];
    const check = (rel: string, block: string) => {
      block.split('\n').forEach((line, i) => {
        const m = /^(\w[\w-]*):\s+(.*)$/.exec(line);
        if (!m) return;
        const value = m[2];
        if (/^["'>|]/.test(value)) return; // quoted or a block scalar
        if (value.includes(': ')) unquoted.push(`${rel}:${i + 1} ${m[1]}`);
      });
    };
    check('_config.yml', readFileSync(join(REPO_ROOT, '_config.yml'), 'utf-8'));
    for (const p of withFm) check(p, frontMatter(p)!);
    expect(unquoted).toEqual([]);
  });

  it('keeps the generator emitting front matter that parses', () => {
    // index.md is generated; fixing the file without fixing the generator would
    // reintroduce the break on the next regeneration.
    const gen = readFileSync(join(REPO_ROOT, 'scripts/gen-readme-index.mjs'), 'utf-8');
    const m = /^---\n([\s\S]*?)\n---/m.exec(gen.slice(gen.indexOf('layout: default') - 4));
    expect(m).not.toBeNull();
    expect(() => parse(m![1])).not.toThrow();
  });
});

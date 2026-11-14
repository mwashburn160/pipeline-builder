// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every API-client method has a caller.
 *
 * `route-permissions` checks that a route's disposition names a surface AND that
 * a domain file holds the route's path — but not that anything calls the method.
 * That gap let a disposition claim "getCampaign on the detail read" and "edit
 * budget/window/exclusivity" for months while both methods had zero callers.
 * A client method nobody calls is either a missing control (build it) or dead
 * code (delete it); either way it must not sit there backing a claim.
 *
 * "A caller" = the method's name as a whole word in a source file under `src/` or
 * `pages/` other than the file that defines it. Tests do not count — a test that
 * stubs a method is not a surface.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from '@jest/globals';

const ROOT = join(__dirname, '..');
const DOMAINS = join(ROOT, 'src/lib/api/domains');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Method names a domain file exposes: factory-object members (`name: async (`)
 *  and exported functions (`export function name(`). */
function methodsOf(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^ {4}(\w+): (?:async )?(?:<[^>]*>)?\(/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export (?:async )?function (\w+)/gm)) names.add(m[1]);
  return [...names];
}

const sources = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'pages'))]
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }));

describe('API client', () => {
  const domainFiles = readdirSync(DOMAINS).filter((f) => f.endsWith('.ts')).map((f) => join(DOMAINS, f));

  it('finds the methods it is checking (the scan is not vacuous)', () => {
    const total = domainFiles.reduce((n, f) => n + methodsOf(readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(500);
  });

  it('every domain-client method is called from src/ or pages/', () => {
    const uncalled: string[] = [];
    for (const domainFile of domainFiles) {
      for (const method of methodsOf(readFileSync(domainFile, 'utf8'))) {
        const word = new RegExp(`\\b${method}\\b`);
        const called = sources.some(({ file, text }) => file !== domainFile && word.test(text));
        if (!called) uncalled.push(`${relative(ROOT, domainFile)}: ${method}`);
      }
    }
    expect({
      uncalled,
      fix: 'Build the control that calls it, or delete the method (and fix any route disposition that names it).',
    }).toEqual({ uncalled: [], fix: expect.any(String) });
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * api-core's browser-safe subpaths (`@pipeline-builder/api-core/<name>`, each a
 * dependency-free leaf under `src/types/`) are a FOUR-SITE contract, all four
 * generated from `.projenrc.ts`:
 *
 *   1. api-core's `exports` — how Node and the Next build resolve it;
 *   2. api-core's `typesVersions` — how the frontend's node10 test tsconfig
 *      finds the declarations, since node10 ignores `exports`;
 *   3. the frontend's jest `moduleNameMapper` — the published file is ESM while
 *      these suites run as CommonJS, so jest must be pointed at the TypeScript
 *      SOURCE and let ts-jest transpile it;
 *   4. the leaf itself importing nothing of the server graph.
 *
 * Miss (3) and the failure is remote from the cause: every suite that
 * transitively imports the subpath dies at LOAD with "Must use import to load
 * ES Module", naming api-core's compiled `lib/`, while `tsc` and the Next build
 * stay perfectly green. That is what happened when `quota-catalog` was added
 * with sites 1, 2 and 4 and without 3.
 *
 * So this suite checks the three declarative sites agree. It reads the
 * package.json files rather than importing anything, so it reports the drift
 * instead of dying of it.
 */

interface Pkg {
  exports?: Record<string, unknown>;
  typesVersions?: Record<string, Record<string, string[]>>;
  jest?: { moduleNameMapper?: Record<string, string> };
}

const read = (p: string): Pkg => JSON.parse(readFileSync(p, 'utf8')) as Pkg;
const apiCore = read(join(__dirname, '../../packages/api-core/package.json'));
const frontend = read(join(__dirname, '../package.json'));

/** The `./x` exports that resolve to a `lib/types/x.js` leaf. */
const typeSubpaths = Object.entries(apiCore.exports ?? {})
  .flatMap(([key, target]) => {
    const dflt = (target as { default?: string } | string | undefined);
    const file = typeof dflt === 'object' && dflt ? dflt.default : undefined;
    const m = /^\.\/lib\/types\/([A-Za-z0-9-]+)\.js$/.exec(file ?? '');
    return m && key === `./${m[1]}` ? [m[1]] : [];
  })
  .sort();

describe('api-core browser-safe subpaths', () => {
  it('finds the subpaths to check', () => {
    // A guard on the guard: a refactor that renames the exports shape would
    // otherwise leave this suite asserting nothing, silently.
    expect(typeSubpaths.length).toBeGreaterThanOrEqual(8);
    expect(typeSubpaths).toContain('permissions');
    expect(typeSubpaths).toContain('quota-catalog');
  });

  it.each(typeSubpaths)('%s has a typesVersions entry', (name) => {
    expect(apiCore.typesVersions?.['*']?.[name]).toEqual([`lib/types/${name}.d.ts`]);
  });

  it.each(typeSubpaths)("%s is mapped to source in the frontend's jest config", (name) => {
    // Exact-match anchors, so `plugin-catalog` cannot swallow `plugin-scan`.
    const mapped = frontend.jest?.moduleNameMapper?.[`^@pipeline-builder/api-core/${name}$`];
    expect(mapped).toBe(`<rootDir>/../packages/api-core/src/types/${name}.ts`);
  });
});

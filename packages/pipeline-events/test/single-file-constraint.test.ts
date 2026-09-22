// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline-manager infra setup-events` ships `lib/index.js` as the ONE file in
 * the Lambda zip (`zip -j … index.mjs`), so the build bundles the handler with
 * esbuild. This bundles `src/index.ts` exactly as the post-compile step does and
 * asserts the result is self-contained: no relative import survives, and the
 * only external modules are the `@aws-sdk/*` clients the Lambda runtime provides.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import { buildSync } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Lambda bundle', () => {
  const out = buildSync({
    entryPoints: [join(pkgDir, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['@aws-sdk/*'],
    write: false,
    logLevel: 'silent',
  }).outputFiles[0]!.text;

  it('has no relative import — the zip contains index.mjs and nothing else', () => {
    expect(out.match(/(?:from|import)\s*\(?\s*['"]\.{1,2}\//g) ?? []).toEqual([]);
  });

  it('imports nothing but @aws-sdk clients and node builtins', () => {
    const specifiers = [...out.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const s of specifiers) expect(s.startsWith('@aws-sdk/') || s.startsWith('node:')).toBe(true);
    expect(out).toContain('export {');
    expect(out).toMatch(/\bhandler\b/);
  });
});

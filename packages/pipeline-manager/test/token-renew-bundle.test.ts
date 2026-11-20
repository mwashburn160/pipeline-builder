// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra store-token --schedule` uploads the token-renew handler as the ONE file
 * in its Lambda zip, so the build bundles it with esbuild. This bundles it the
 * way the post-compile step does and asserts the result is self-contained. The
 * runner handler imports api-core's dependency-free `pipeline-runners` subpath;
 * esbuild inlines it (only `@aws-sdk/*` is external), so no mirror is kept.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import { buildSync } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe.each(['token-renew-handler', 'runner-handler'])('%s Lambda bundle', (entry) => {
  it('imports nothing but @aws-sdk clients (no workspace package, no relative file)', () => {
    const out = buildSync({
      entryPoints: [join(pkgDir, `src/lambda/${entry}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      external: ['@aws-sdk/*'],
      write: false,
      logLevel: 'silent',
    }).outputFiles[0]!.text;
    const specifiers = [...out.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(specifiers.every((s) => s.startsWith('@aws-sdk/') || s.startsWith('node:'))).toBe(true);
    expect(out).toMatch(/\bhandler\b/);
  });
});

describe('runner-handler Lambda bundle', () => {
  it('inlines the shared runner contract (api-core\'s dependency-free pipeline-runners catalog), no copy kept locally', () => {
    const out = buildSync({
      entryPoints: [join(pkgDir, 'src/lambda/runner-handler.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      external: ['@aws-sdk/*'],
      write: false,
      logLevel: 'silent',
    }).outputFiles[0]!.text;
    expect(out).not.toMatch(/@pipeline-builder\//);
    // The catalog's values are in the one file the stack uploads.
    expect(out).toContain('pb-run+jwt');
    expect(out).toContain('RUNNER_PERMISSION_DENIED');
    expect(out).toContain('/api/pipelines/runner/runners/');
    expect(out).not.toContain('/api/pipelines/runner/jwks.json');
  });
});

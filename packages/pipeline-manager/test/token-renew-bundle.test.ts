// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra store-token --schedule` uploads the token-renew handler as the ONE file
 * in its Lambda zip, so the build bundles it with esbuild. This bundles it the
 * way the post-compile step does and asserts the result is self-contained.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import { buildSync } from 'esbuild';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('token-renew Lambda bundle', () => {
  it('imports nothing but @aws-sdk clients (no workspace package, no relative file)', () => {
    const out = buildSync({
      entryPoints: [join(pkgDir, 'src/lambda/token-renew-handler.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: ['@aws-sdk/*'],
      write: false,
      logLevel: 'silent',
    }).outputFiles[0]!.text;
    const specifiers = [...out.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(specifiers.every((s) => s.startsWith('@aws-sdk/') || s.startsWith('node:'))).toBe(true);
    expect(out).toMatch(/\bhandler\b/);
  });
});

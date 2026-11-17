#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-artifact half of the package-surface contract, for the workspace
 * package in the current directory (run from each library's `post-compile`,
 * after tsc — see projenrc/package.ts).
 *
 * Fails the build when:
 *   - the `exports` map is missing, has a wildcard, or lacks `./package.json`;
 *   - any exports target (workspace or published) does not exist on disk after
 *     compile — a renamed/removed entry module would otherwise publish a map
 *     that points at nothing;
 *   - a PUBLISHED target (`publishConfig.exports`, else `exports`) is stripped
 *     from the tarball by the package's .npmignore.
 *
 * The source-level half (no consumer imports a non-exported subpath) is
 * test/deploy-contracts/test/package-surface-contract.test.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const errors = [];

const targets = (t) => (typeof t === 'string' ? [t] : Object.values(t ?? {}).filter((v) => typeof v === 'string'));

const exp = pkg.exports;
if (!exp || typeof exp !== 'object') {
  errors.push('no `exports` map');
} else {
  if (exp['./package.json'] !== './package.json') errors.push('`exports` lacks "./package.json"');
  const published = pkg.publishConfig?.exports ?? exp;
  const ignored = existsSync(join(cwd, '.npmignore'))
    ? readFileSync(join(cwd, '.npmignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/lib/'))
    : [];
  for (const [map, label] of [[exp, 'exports'], [published, 'publishConfig.exports']]) {
    for (const [key, target] of Object.entries(map)) {
      if (key.includes('*')) errors.push(`${label}["${key}"]: wildcard subpath`);
      for (const p of targets(target)) {
        if (p.includes('*')) errors.push(`${label}["${key}"]: wildcard target ${p}`);
        else if (!existsSync(join(cwd, p))) errors.push(`${label}["${key}"]: ${p} does not exist after compile`);
        if (map === published) {
          const rule = ignored.find((r) => `/${p.replace(/^\.\//, '')}`.startsWith(r));
          if (rule) errors.push(`${label}["${key}"]: ${p} is published but .npmignore strips it (${rule})`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error(`check-package-surface: ${pkg.name}:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

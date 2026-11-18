// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Node floor is a MAJOR.MINOR rule: any 26.13 patch (and anything newer) is
 * accepted, anything older is refused — everywhere the floor is stated or
 * enforced, from ONE projen constant (`minNodeVersion` in .projenrc.ts):
 *
 * - every package's `engines.node` is `>= <MAJOR>.<MINOR>.0`;
 * - `.npmrc` sets `engine-strict=true`, so `pnpm install` refuses an older Node;
 * - `.nvmrc` / `.node-version` name `<MAJOR>.<MINOR>` (nvm / fnm / asdf pick the
 *   newest patch of that line);
 * - the repo-wide jest setup (`jest-env-guard.js`) fails fast on an older Node,
 *   comparing MAJOR and MINOR only.
 *
 * The exact runtime the images and CI ship is a separate pin, checked in
 * toolchain-drift-contract.test.ts.
 */

import { createRequire } from 'module';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { parse } from 'yaml';
import { REPO_ROOT, read } from '../src/index.js';

const require = createRequire(import.meta.url);
const guard = require(join(REPO_ROOT, 'jest-env-guard.js')) as {
  nodeVersionProblem: (found: string, floor: string) => string | undefined;
};

const minNodeVersion = /minNodeVersion:\s*'([0-9.]+)'/.exec(read('.projenrc.ts'))?.[1];
const majorMinor = minNodeVersion?.split('.').slice(0, 2).join('.');

describe('Node floor', () => {
  it('projen\'s minNodeVersion is a MAJOR.MINOR.0 floor', () => {
    expect(minNodeVersion).toMatch(/^\d+\.\d+\.0$/);
  });

  it('every workspace package (and the root) declares engines.node ">= MAJOR.MINOR.0"', () => {
    const dirs = ['.', ...(parse(read('pnpm-workspace.yaml')) as { packages: string[] }).packages];
    const engines = Object.fromEntries(dirs.map((d) => [d, (JSON.parse(read(`${d}/package.json`)) as { engines?: { node?: string } }).engines?.node]));
    expect(engines).toEqual(Object.fromEntries(dirs.map((d) => [d, `>= ${majorMinor}.0`])));
  });

  it('.npmrc makes the engines floor binding (engine-strict)', () => {
    expect(read('.npmrc').split('\n')).toContain('engine-strict=true');
  });

  it('.nvmrc and .node-version name the MAJOR.MINOR line', () => {
    expect({ nvmrc: read('.nvmrc').trim(), nodeVersion: read('.node-version').trim() })
      .toEqual({ nvmrc: majorMinor, nodeVersion: majorMinor });
  });
});

describe('jest-env-guard Node check (MAJOR.MINOR only)', () => {
  const floor = '26.13';
  it.each([
    ['26.12.9', false],
    ['26.13.0', true],
    ['26.13.7', true],
    ['27.0.0', true],
    ['25.99.0', false],
    ['25.9.1', false],
    ['v26.13.1', true],
  ])('%s -> accepted=%s', (found, ok) => {
    const problem = guard.nodeVersionProblem(found, floor);
    if (ok) {
      expect(problem).toBeUndefined();
    } else {
      expect(problem).toBe(`Node >= 26.13 required (found ${found.replace(/^v/, '')})`);
    }
  });

  it('reads its floor from .nvmrc (the projen-generated MAJOR.MINOR)', () => {
    expect(read('jest-env-guard.js')).toMatch(/\.nvmrc/);
  });
});

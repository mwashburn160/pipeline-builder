// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract (D10, Phase 0): the Node major self-mutation pins through
 * `runtime-versions.nodejs` must be one the pinned aws-cdk CLI's
 * `engines.node` accepts AND one `aws/codebuild/standard:8.0` publishes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import {
  CURATED_SELF_MUTATION_IMAGE, CURATED_SELF_MUTATION_NODE_RUNTIMES, SELF_MUTATION_NODE_MAJOR, selfMutationPartialBuildSpec,
} from '../src/core/self-mutation.js';

const here = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = resolve(here, '../../../deploy/toolchain/pipeline-bootstrap/Dockerfile');

/**
 * `engines.node` of the aws-cdk CLI the toolchain pins. The CLI is not a
 * workspace dependency (it ships in the bootstrap image), so its range is
 * recorded here beside the version it was read from; the test below fails when
 * the Dockerfile's `AWS_CDK_VERSION` moves, forcing a re-read
 * (`npm view aws-cdk@<V> engines`), and cross-checks against an installed copy
 * when one is resolvable.
 */
const PINNED_CLI = { version: '2.1148.0', enginesNode: '>= 18.0.0' };

/** Whether Node `<major>.x` satisfies a range of `>=`/`^`/`~`/bare-major comparators joined by `||`. */
function majorSatisfies(major: number, range: string): boolean {
  return range.split('||').some((alt) => {
    const comparators = alt.trim().replace(/(>=|<=|>|<|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return comparators.every((c) => {
      const m = /^(>=|<=|>|<|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(c);
      if (!m) throw new Error(`unsupported engines comparator "${c}" — extend majorSatisfies`);
      const [, op, maj] = m;
      const n = Number(maj);
      switch (op) {
        case '>=': return major >= n;
        case '>': return major > n;
        case '<=': return major <= n;
        case '<': return major < n;
        default: return major === n; // ^, ~ and bare majors pin the major
      }
    });
  });
}

/** An installed aws-cdk CLI's package.json (workspace node_modules, then the global prefix), if any. */
function installedCliPackage(): { version: string; engines?: { node?: string } } | null {
  const candidates: string[] = [];
  try { candidates.push(createRequire(import.meta.url).resolve('aws-cdk/package.json')); } catch { /* not a workspace dep */ }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(join(root, 'aws-cdk', 'package.json'));
  } catch { /* npm unavailable */ }
  for (const file of candidates) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  }
  return null;
}

describe('self-mutation Node runtime contract', () => {
  it('the recorded CLI is the one the bootstrap image pins', () => {
    const arg = /^ARG AWS_CDK_VERSION="([^"]+)"/m.exec(readFileSync(DOCKERFILE, 'utf-8'))?.[1];
    expect(arg).toBe(PINNED_CLI.version);
  });

  it('the pinned Node major is inside the pinned CLI\'s engines.node', () => {
    expect(majorSatisfies(SELF_MUTATION_NODE_MAJOR, PINNED_CLI.enginesNode)).toBe(true);
  });

  it('the recorded engines.node matches an installed copy of that CLI version (when one is installed)', () => {
    const pkg = installedCliPackage();
    if (!pkg || pkg.version !== PINNED_CLI.version) return; // nothing installed at this version to cross-check
    expect(pkg.engines?.node).toBe(PINNED_CLI.enginesNode);
  });

  it('the pinned Node major is one standard:8.0 publishes', () => {
    expect(CURATED_SELF_MUTATION_IMAGE).toBe('aws/codebuild/standard:8.0');
    expect(CURATED_SELF_MUTATION_NODE_RUNTIMES).toContain(SELF_MUTATION_NODE_MAJOR);
  });

  it('the partial buildspec pins exactly that major', () => {
    expect(selfMutationPartialBuildSpec()).toEqual({ phases: { install: { 'runtime-versions': { nodejs: String(SELF_MUTATION_NODE_MAJOR) } } } });
  });

  it('majorSatisfies reads the range forms engines use', () => {
    expect(majorSatisfies(24, '>= 18.0.0')).toBe(true);
    expect(majorSatisfies(16, '>= 18.0.0')).toBe(false);
    expect(majorSatisfies(20, '^18.0.0 || ^20.0.0')).toBe(true);
    expect(majorSatisfies(22, '^18.0.0 || ^20.0.0')).toBe(false);
    expect(majorSatisfies(22, '>=18 <23')).toBe(true);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ONE lockfile: the workspace root's `pnpm-lock.yaml`.
 *
 * This is a single pnpm workspace with a shared lockfile; CI installs with
 * `--frozen-lockfile` from the root, so the root lockfile is the only one that
 * decides what gets installed. A nested one (a `pnpm install` run inside a
 * package without the workspace in view) is never read by CI, silently drifts
 * from the real resolution, and misleads anyone — or any scanner — reading it.
 * `packages/api-core/pnpm-lock.yaml` sat in the tree that way from the initial
 * commit.
 */

import { execFileSync, spawnSync } from 'child_process';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

/** Tracked files plus untracked-but-not-ignored ones (what the next `git add -A` would commit). */
const files = (): string[] => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter(Boolean);

const ignored = (rel: string): boolean => spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: REPO_ROOT }).status === 0;

describe('pnpm lockfile', () => {
  it('exactly one pnpm-lock.yaml is in the repo, at the root', () => {
    const lockfiles = files().filter((f) => f === 'pnpm-lock.yaml' || f.endsWith('/pnpm-lock.yaml'));
    expect(lockfiles).toEqual(['pnpm-lock.yaml']);
  });

  it('a nested lockfile is gitignored (so one can never be committed again); the root one is not', () => {
    const nested = ['packages/api-core/pnpm-lock.yaml', 'api/plugin/pnpm-lock.yaml', 'platform/pnpm-lock.yaml', 'frontend/pnpm-lock.yaml', 'test/deploy-contracts/pnpm-lock.yaml'];
    expect(Object.fromEntries(nested.map((p) => [p, ignored(p)]))).toEqual(Object.fromEntries(nested.map((p) => [p, true])));
    expect(ignored('pnpm-lock.yaml')).toBe(false);
  });
});

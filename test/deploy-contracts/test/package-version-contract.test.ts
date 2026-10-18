// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * No package may be committed at version 0.0.0.
 *
 * projen regenerates every package.json wholesale and writes `"version":
 * "0.0.0"`, because it expects a release tool to stamp the real one. That is
 * harmless until the reset is COMMITTED, and then it breaks the release in a
 * way that only shows up at the very end of it:
 *
 *   npm error 400 Cannot publish over previously published version "0.0.0".
 *
 * The reason it is not caught earlier is `--first-release`. The release runs
 * `nx release --first-release --skip-publish`, and that flag makes nx IGNORE
 * the git tags and treat package.json as the starting point — so the tags can
 * be perfectly correct (they were) while the publish still goes out as 0.0.0.
 * Nothing between the commit and the npm rejection looks at the number.
 *
 * `.projenrc.ts` now reads each version back off disk and re-applies it after
 * synth (`currentVersion`), so this should not recur. This test is the backstop
 * for that: it fails in the build, where it is cheap, rather than in the
 * publish step after the images have already been pushed.
 *
 * A genuinely new package has no release yet and no tag. It still must not be
 * committed at 0.0.0 — give it a real starting version (0.1.0, or 0.0.1) so the
 * first release has something to bump from.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

/** Every workspace package.json, from the pnpm workspace globs. */
function workspacePackages(): string[] {
  const yaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf-8');
  // `packages:` entries are plain paths here (no globstars), one per line.
  const dirs = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?\s*$/gm)]
    .map((m) => m[1])
    .filter((d) => d && !d.startsWith('!'));
  return dirs.map((d) => join(d, 'package.json'));
}

interface Pkg { path: string; name?: string; version?: string; private?: boolean }

function read(rel: string): Pkg | null {
  try {
    const d = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf-8'));
    return { path: rel, name: d.name, version: d.version, private: d.private };
  } catch {
    return null; // a workspace entry with no package.json on disk
  }
}

describe('package versions', () => {
  const pkgs = workspacePackages().map(read).filter((p): p is Pkg => p !== null);

  it('finds the workspace packages (guards a vacuous pass)', () => {
    // The workspace has ~19 members; a handful means the glob parsing broke and
    // every assertion below would pass by checking nothing.
    expect(pkgs.length).toBeGreaterThanOrEqual(15);
    expect(pkgs.map((p) => p.name)).toContain('@pipeline-builder/api-core');
  });

  it('never commits a package at 0.0.0', () => {
    // This is the exact state that produced
    //   "Cannot publish over previously published version 0.0.0"
    // at the end of a release, after the images had already been published.
    const zeroed = pkgs.filter((p) => p.version === '0.0.0').map((p) => `${p.path} (${p.name})`);
    expect(zeroed).toEqual([]);
  });

  it('gives every package a version at all', () => {
    const missing = pkgs.filter((p) => !p.version).map((p) => `${p.path} (${p.name})`);
    expect(missing).toEqual([]);
  });

  it('keeps every version parseable as semver', () => {
    const bad = pkgs
      .filter((p) => p.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(p.version))
      .map((p) => `${p.path}: ${p.version}`);
    expect(bad).toEqual([]);
  });

  it('keeps .projenrc.ts restoring versions after synth', () => {
    // Without this the next `pnpm dlx projen` silently zeroes all of them
    // again, and the assertions above only catch it if somebody runs the build
    // before committing.
    const projenrc = readFileSync(join(REPO_ROOT, '.projenrc.ts'), 'utf-8');
    expect(projenrc).toContain('function currentVersion(');
    expect(projenrc).toMatch(/addField\('version', version\)/);
  });
});

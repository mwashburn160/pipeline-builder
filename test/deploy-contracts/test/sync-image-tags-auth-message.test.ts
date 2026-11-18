// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * sync-image-tags.sh tells an ANONYMOUS 401 apart from a stale credential.
 *
 * The script resolves each image's digest with `docker buildx imagetools
 * inspect` and classifies a failure from its stderr. GHCR answers an
 * anonymous pull of a PRIVATE (or never-published) package with
 * `failed to fetch anonymous token: … 401 Unauthorized`. That text also
 * contains `failed to authorize` and `401`, so without a branch of its own it
 * fell into the stale-credential advice ("docker logout ghcr.io") — the wrong
 * fix: no credential was sent, and the real one is making the package public.
 *
 * The script is run for real, not re-implemented: a copy of it (with the
 * common.sh / tool-pins.sh it sources) sits in a throwaway tree holding a
 * one-service services.txt and that service's package.json, and a stub
 * `docker` on PATH fails the inspect with the registry's exact text. ROOT is
 * derived from the script's own location, so the copy reads and could write
 * only the throwaway tree; the inspect failure exits before any write anyway,
 * which the last case checks against the real deploy tree too.
 */

import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

const SVC = 'ops-center';
const VERSION = '9.8.7';

/** The registry's own reply to an anonymous pull of a private package. */
const ANONYMOUS_401 = 'ERROR: failed to authorize: failed to fetch anonymous token: unexpected status from GET request to '
  + `https://ghcr.io/token?scope=repository%3Amwashburn160%2F${SVC}%3Apull&service=ghcr.io: 401 Unauthorized`;
/** A request that DID carry a credential, refused. */
const CREDENTIALED_403 = `ERROR: failed to authorize: unexpected status from HEAD request to https://ghcr.io/v2/mwashburn160/${SVC}/manifests/${VERSION}: 403 Forbidden\ndenied: denied`;

const PRIVATE_MESSAGE = /package\s+'ops-center' is private or has never been published/;
const PUBLIC_FIX = 'Change\n       visibility → Public';
const STALE_MESSAGE = 'stale ghcr.io credential';

const sandboxes: string[] = [];
afterAll(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true }); });

/**
 * A throwaway repo root holding the script (optionally transformed), what it
 * sources, a one-service services.txt and that service's package.json, plus a
 * `bin/docker` whose inspect writes `stderr` and exits 1.
 */
function sandbox(stderr: string, transform: (script: string) => string = (s) => s): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'pb-sync-tags-'));
  sandboxes.push(root);
  const binDir = join(root, 'deploy/bin');
  mkdirSync(binDir, { recursive: true });
  for (const f of ['common.sh', 'tool-pins.sh']) copyFileSync(join(REPO_ROOT, 'deploy/bin', f), join(binDir, f));
  writeFileSync(join(binDir, 'sync-image-tags.sh'), transform(readFileSync(join(REPO_ROOT, 'deploy/bin/sync-image-tags.sh'), 'utf-8')));
  mkdirSync(join(root, 'deploy/local/docker'), { recursive: true });
  writeFileSync(join(root, 'deploy/local/docker/services.txt'), `# test\nservice ${SVC} api/${SVC}\n`);
  mkdirSync(join(root, 'api', SVC), { recursive: true });
  writeFileSync(join(root, 'api', SVC, 'package.json'), JSON.stringify({ name: SVC, version: VERSION }));

  const bin = join(root, 'stub-bin');
  mkdirSync(bin);
  writeFileSync(join(root, 'stderr.txt'), `${stderr}\n`);
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    'if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then',
    `  cat "${join(root, 'stderr.txt')}" >&2`,
    '  exit 1',
    'fi',
    'echo "unexpected docker call: $*" >&2',
    'exit 99',
  ].join('\n'));
  chmodSync(join(bin, 'docker'), 0o755);
  return { root, bin };
}

function run(box: { root: string; bin: string }): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [join(box.root, 'deploy/bin/sync-image-tags.sh')], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${box.bin}:${process.env.PATH}`, OWNER: 'mwashburn160' },
    timeout: 30_000,
  });
  return { status: r.status, stderr: r.stderr };
}

/** Every file under `dir`, relative, sorted. */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? tree(dir, rel) : [rel];
  }).sort();
}

/** The real deploy tree's working-tree state (status + content of every change). */
const deployState = (): string => execFileSync('git', ['status', '--porcelain', '--', 'deploy'], { cwd: REPO_ROOT, encoding: 'utf-8' })
  + execFileSync('git', ['diff', '--', 'deploy'], { cwd: REPO_ROOT, encoding: 'utf-8' });

/** The script with its `*"anonymous token"*` case branch cut out (for the self-check). */
function withoutAnonymousBranch(script: string): string {
  const out = script.replace(/\n\s*\*"anonymous token"\*\)[\s\S]*?;;\n/, '\n');
  if (out === script) throw new Error('the *"anonymous token"* branch was not found in sync-image-tags.sh');
  return out;
}

describe('sync-image-tags.sh — classifying a failed digest lookup', () => {
  it('an anonymous 401 is reported as a private / unpublished package, not a stale login', () => {
    const { status, stderr } = run(sandbox(ANONYMOUS_401));
    expect(status).toBe(1);
    expect(stderr).toContain(ANONYMOUS_401); // the registry's own text is echoed first
    expect(stderr).toMatch(PRIVATE_MESSAGE);
    expect(stderr).toContain(PUBLIC_FIX);
    expect(stderr).toContain(`ghcr.io/mwashburn160/${SVC}:${VERSION}`);
    expect(stderr).not.toContain(STALE_MESSAGE);
    expect(stderr).not.toContain('docker logout');
  });

  it('a credentialed 403 / denied is reported as a stale credential', () => {
    const { status, stderr } = run(sandbox(CREDENTIALED_403));
    expect(status).toBe(1);
    expect(stderr).toContain(STALE_MESSAGE);
    expect(stderr).toContain('docker logout ghcr.io');
    expect(stderr).not.toMatch(PRIVATE_MESSAGE);
  });

  it('a failed lookup writes nothing — neither in its own tree nor in the real deploy tree', () => {
    const before = deployState();
    const box = sandbox(ANONYMOUS_401);
    const files = tree(box.root);
    const snapshot = files.map((f) => readFileSync(join(box.root, f), 'utf-8'));
    expect(run(box).status).toBe(1);
    expect(tree(box.root)).toEqual(files);
    expect(files.map((f) => readFileSync(join(box.root, f), 'utf-8'))).toEqual(snapshot);
    expect(deployState()).toBe(before);
  });

  it('self-check: without the anonymous-token branch the 401 falls into the stale-credential advice', () => {
    const { status, stderr } = run(sandbox(ANONYMOUS_401, withoutAnonymousBranch));
    expect(status).toBe(1);
    expect(stderr).not.toMatch(PRIVATE_MESSAGE);
    expect(stderr).toContain(STALE_MESSAGE);
  });
});

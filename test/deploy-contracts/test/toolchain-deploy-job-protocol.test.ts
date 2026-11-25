// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain release records the deploy-job protocol its cdk-synth
 * image speaks. The platform copies the cdk-synth spec's
 * `metadata['pb:deploy-job:protocol']` (api-core DEPLOY_JOB_PROTOCOL_METADATA_KEY)
 * onto `toolchain_release.deploy_job_protocol` on upload; a release without it
 * answers TOOLCHAIN_TOO_OLD_FOR_DEPLOY.
 *
 *  - the spec carries the key, equal to api-core's DEPLOY_JOB_PROTOCOL_VERSION;
 *  - build-plugin-images.sh FAILS the cdk-synth build when the value differs
 *    from what the built image's `pipeline-manager pipeline deploy-job
 *    --protocol` prints (its gate function is run for real, with a stub docker);
 *  - the key is excluded from the toolchain sourceDigest, like the other
 *    generated / image-derived fields (sync-image-tags.sh's normaliser is run
 *    for real). The value is a function of the image: it only changes with a
 *    pipeline-manager release, whose PIPELINE_MANAGER_VERSION ARG is already a
 *    hashed input, and the build gate refuses a value the image does not print.
 */

import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from '@jest/globals';
import { parse } from 'yaml';
import { read } from '../src/index.js';

const RUNNERS = 'packages/api-core/src/types/pipeline-runners.ts';
const SYNTH_SPEC = 'deploy/toolchain/cdk-synth/plugin-spec.yaml';
const KEY = /export const DEPLOY_JOB_PROTOCOL_METADATA_KEY = '([^']+)';/.exec(read(RUNNERS))?.[1];
const VERSION = Number(/export const DEPLOY_JOB_PROTOCOL_VERSION = (\d+);/.exec(read(RUNNERS))?.[1]);

const sandboxes: string[] = [];
afterAll(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true }); });

/** One top-level shell function's source, cut from a script (`name() {` to the first `}` line). */
function shellFunction(script: string, name: string): string {
  const text = read(script);
  const start = text.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name}() not found in ${script}`);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start + 1, end + 3);
}

describe('the cdk-synth spec records the deploy-job protocol', () => {
  it('api-core exports the key and a whole-number version', () => {
    expect(KEY).toBe('pb:deploy-job:protocol');
    expect(Number.isSafeInteger(VERSION) && VERSION >= 1).toBe(true);
  });

  it('metadata[DEPLOY_JOB_PROTOCOL_METADATA_KEY] == DEPLOY_JOB_PROTOCOL_VERSION', () => {
    const spec = parse(read(SYNTH_SPEC)) as { metadata?: Record<string, unknown> };
    expect({ [KEY!]: spec.metadata?.[KEY!] }).toEqual({ [KEY!]: VERSION });
  });

  it('only the cdk-synth half carries it', () => {
    const bs = parse(read('deploy/toolchain/pipeline-bootstrap/plugin-spec.yaml')) as { metadata?: Record<string, unknown> };
    expect(bs.metadata?.[KEY!]).toBeUndefined();
  });
});

describe('build-plugin-images.sh gates the cdk-synth build on the image\'s protocol', () => {
  const SCRIPT = 'deploy/bin/build-plugin-images.sh';
  const FN = '_check_deploy_job_protocol';

  /** Run the gate with a stub `docker` whose `run` prints `stdout` and exits `code`. */
  function gate(specMetadataLine: string | null, stdout: string, code = 0): { status: number | null; stderr: string } {
    const root = mkdtempSync(join(tmpdir(), 'pb-protocol-gate-'));
    sandboxes.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), [
      '#!/usr/bin/env bash',
      `printf '%s' '${stdout}'`,
      `exit ${code}`,
    ].join('\n'));
    chmodSync(join(bin, 'docker'), 0o755);
    const spec = join(root, 'plugin-spec.yaml');
    writeFileSync(spec, ['name: cdk-synth', 'metadata:', '  aws:cdk:pipelines:codepipeline:selfmutation: true',
      ...(specMetadataLine === null ? [] : [specMetadataLine]), 'dockerfile: Dockerfile', ''].join('\n'));
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${shellFunction(SCRIPT, FN)}\n${FN} plugin:abc "$1"`, 'gate', spec], {
      encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLISH_PLATFORM: 'linux/amd64' }, timeout: 30_000,
    });
    return { status: r.status, stderr: r.stderr };
  }

  it('passes when the spec value equals what the image prints', () => {
    const r = gate('  pb:deploy-job:protocol: 1', '1\n');
    expect(r.status).toBe(0);
  });

  it('accepts a trailing comment (as in the real spec)', () => {
    expect(gate('  pb:deploy-job:protocol: 1 # see README', '1\n').status).toBe(0);
  });

  it('accepts a quoted digit string', () => {
    expect(gate('  "pb:deploy-job:protocol": \'2\'', '2\n').status).toBe(0);
  });

  it('runs the built image\'s pipeline-manager deploy-job --protocol', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-protocol-calls-'));
    sandboxes.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'calls.txt');
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\necho "$*" >> "${log}"\necho 1\n`);
    chmodSync(join(bin, 'docker'), 0o755);
    const spec = join(root, 'plugin-spec.yaml');
    writeFileSync(spec, 'metadata:\n  pb:deploy-job:protocol: 1\n');
    const r = spawnSync('bash', ['-c', `set -euo pipefail\n${shellFunction(SCRIPT, FN)}\n${FN} plugin:abc "$1"`, 'gate', spec], {
      encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLISH_PLATFORM: 'linux/amd64' }, timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const calls = readFileSync(log, 'utf-8');
    expect(calls).toMatch(/^run --rm .*--entrypoint pipeline-manager plugin:abc pipeline deploy-job --protocol$/m);
  });

  it('fails when the image prints a different protocol', () => {
    const r = gate('  pb:deploy-job:protocol: 1', '2\n');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pb:deploy-job:protocol/);
    expect(r.stderr).toMatch(/2/);
  });

  it('fails when the spec has no value', () => {
    const r = gate(null, '1\n');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pb:deploy-job:protocol/);
  });

  it('fails when the image cannot report one (an older CLI without deploy-job --protocol)', () => {
    const r = gate('  pb:deploy-job:protocol: 1', '', 1);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pb:deploy-job:protocol/);
  });

  it('build_plugin_dir calls it for the managed cdk-synth image, before saving image.tar', () => {
    const body = read(SCRIPT);
    const fn = body.slice(body.indexOf('\nbuild_plugin_dir() {'));
    const call = fn.indexOf(`${FN} "plugin:\${tag}" "$plugin_dir/plugin-spec.yaml"`);
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(fn.indexOf('docker save "plugin:${tag}"'));
  });
});

describe('sync-image-tags.sh leaves the protocol out of the toolchain sourceDigest', () => {
  function normalise(spec: string): string {
    const root = mkdtempSync(join(tmpdir(), 'pb-protocol-digest-'));
    sandboxes.push(root);
    const file = join(root, 'plugin-spec.yaml');
    writeFileSync(file, spec);
    const r = spawnSync('bash', ['-c', `${shellFunction('deploy/bin/sync-image-tags.sh', '_toolchain_normalise')}\n_toolchain_normalise spec "$1"`, 'n', file], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    return r.stdout;
  }

  it('a spec with and without the key normalise the same', () => {
    const base = 'name: cdk-synth\nmetadata:\n  aws:cdk:x: true\n';
    expect(normalise(`${base}  pb:deploy-job:protocol: 7\n`)).toBe(normalise(base));
    expect(normalise(`${base}  "pb:deploy-job:protocol": "7"\n`)).toBe(normalise(base));
  });

  it('other metadata still counts', () => {
    expect(normalise('metadata:\n  aws:cdk:x: true\n')).not.toBe(normalise('metadata:\n  aws:cdk:x: false\n'));
  });
});

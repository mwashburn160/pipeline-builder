// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The toolchain release's generated spec fields, computed as
 * deploy/bin/sync-image-tags.sh --toolchain-only does — checked against the
 * CHECKED-IN release (its recorded sourceDigest and toolchain must come out of
 * the same computation, and rewriting a spec with its own values must
 * reproduce it byte for byte).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from '@jest/globals';

const {
  refreshNodeImage, rewriteBootstrapSpec, rewriteSynthDockerfile, toolchainFromDockerfile, toolchainInputsOf, toolchainSourceDigest, toolchainSpecChange,
} = await import('../src/services/remediation/toolchain-spec.js');

const REPO = join(import.meta.dirname, '..', '..', '..');
const dirTree = (d: string): Map<string, string> => {
  const root = join(REPO, 'deploy', 'toolchain', d);
  return new Map(readdirSync(root).filter((f) => statSync(join(root, f)).isFile()).map((f) => [f, readFileSync(join(root, f), 'utf8')]));
};
const repoTrees = () => ({ 'pipeline-bootstrap': dirTree('pipeline-bootstrap'), 'cdk-synth': dirTree('cdk-synth') });
const field = (spec: string, key: string) => new RegExp(`^${key}:\\s*"?([^"\\s]+)"?\\s*$`, 'm').exec(spec)?.[1];

describe('the checked-in release', () => {
  const trees = repoTrees();
  const bsSpec = trees['pipeline-bootstrap'].get('plugin-spec.yaml')!;

  it('recomputes the recorded sourceDigest', () => {
    expect(toolchainSourceDigest(trees)).toBe(field(bsSpec, 'sourceDigest'));
  });

  it('reads the recorded toolchain from the bootstrap Dockerfile ARGs', () => {
    const tc = toolchainFromDockerfile(trees['pipeline-bootstrap'].get('Dockerfile')!);
    expect(tc).toEqual({
      pipelineManager: /pipelineManager: "([^"]+)"/.exec(bsSpec)![1],
      awsCdk: /awsCdk: "([^"]+)"/.exec(bsSpec)![1],
      cdkAssets: /cdkAssets: "([^"]+)"/.exec(bsSpec)![1],
      node: /node: "([^"]+)"/.exec(bsSpec)![1],
    });
  });

  it('rewriting a spec with its own values reproduces it byte for byte (the sync is a no-op)', () => {
    const tc = toolchainFromDockerfile(trees['pipeline-bootstrap'].get('Dockerfile')!)!;
    expect(rewriteBootstrapSpec(bsSpec, field(bsSpec, 'version')!, tc, field(bsSpec, 'sourceDigest')!)).toBe(bsSpec);
    const synthDf = trees['cdk-synth'].get('Dockerfile')!;
    expect(rewriteSynthDockerfile(synthDf, field(bsSpec, 'version')!)).toBe(synthDf);
  });

  it('build inputs exclude config.yaml, README.md and the build outputs', () => {
    expect([...toolchainInputsOf(new Map([['Dockerfile', 'x'], ['config.yaml', 'y'], ['README.md', 'z'], ['image.tar', 'b'], ['sub/x', 'q'], ['plugin-spec.yaml', 's']])).keys()])
      .toEqual(['Dockerfile', 'plugin-spec.yaml']);
  });

  it('the generated fields do not change the digest; any other input does', () => {
    const base = toolchainSourceDigest(trees);
    const bumped = { ...trees, 'pipeline-bootstrap': new Map(trees['pipeline-bootstrap']).set('plugin-spec.yaml', bsSpec.replace(/^version:.*$/m, 'version: 9.9.9')) };
    expect(toolchainSourceDigest(bumped)).toBe(base);
    const synth = new Map(trees['cdk-synth']);
    synth.set('Dockerfile', synth.get('Dockerfile')!.replace(/^ARG BOOTSTRAP_IMAGE=.*$/m, 'ARG BOOTSTRAP_IMAGE="pipeline-bootstrap:9.9.9"'));
    expect(toolchainSourceDigest({ ...trees, 'cdk-synth': synth })).toBe(base);
    const df = new Map(trees['pipeline-bootstrap']).set('Dockerfile', `${trees['pipeline-bootstrap'].get('Dockerfile')!}# x\n`);
    expect(toolchainSourceDigest({ ...trees, 'pipeline-bootstrap': df })).not.toBe(base);
  });

  it('the cdk-synth deploy-job protocol metadata is not a build input (as sync-image-tags.sh)', () => {
    const base = toolchainSourceDigest(trees);
    const synth = new Map(trees['cdk-synth']);
    const spec = synth.get('plugin-spec.yaml')!;
    expect(spec).toMatch(/^[ \t]+["']?pb:deploy-job:protocol["']?:/m);
    synth.set('plugin-spec.yaml', spec.replace(/^([ \t]+["']?pb:deploy-job:protocol["']?:).*$/m, '$1 99'));
    expect(toolchainSourceDigest({ ...trees, 'cdk-synth': synth })).toBe(base);
  });
});

describe('the node base refresh', () => {
  const df = 'ARG NODE_IMAGE=node:26.13.1-slim@sha256:' + 'a'.repeat(64) + '\nFROM ${NODE_IMAGE}\n';
  it('moves the digest within the same tag', async () => {
    const r = await refreshNodeImage(df, async (ref) => (ref === 'node:26.13.1-slim' ? `sha256:${'b'.repeat(64)}` : null));
    expect(r).toEqual({ dockerfile: df.replace('a'.repeat(64), 'b'.repeat(64)), from: `node:26.13.1-slim@sha256:${'a'.repeat(64)}`, to: `node:26.13.1-slim@sha256:${'b'.repeat(64)}` });
    expect(toolchainFromDockerfile(`${r!.dockerfile}ARG PIPELINE_MANAGER_VERSION="1.0.0"\nARG AWS_CDK_VERSION="2.0.0"\nARG CDK_ASSETS_VERSION="3.0.0"\n`)!.node).toBe('26.13.1');
  });
  it('null when unresolvable or already current', async () => {
    expect(await refreshNodeImage(df, async () => null)).toBeNull();
    expect(await refreshNodeImage(df, async () => `sha256:${'a'.repeat(64)}`)).toBeNull();
  });
});

describe('the spec change of a candidate', () => {
  it('bumps the release in both specs and the synth default base, refreshes toolchain + sourceDigest, as a repo-rooted diff', () => {
    const original = repoTrees();
    const bsDf = original['pipeline-bootstrap'].get('Dockerfile')!;
    const oldDigest = /ARG NODE_IMAGE=node:[^@]+@(sha256:[0-9a-f]{64})/.exec(bsDf)![1]!;
    const patchedDf = bsDf.replace(oldDigest, `sha256:${'e'.repeat(64)}`);
    const patched = { ...original, 'pipeline-bootstrap': new Map(original['pipeline-bootstrap']).set('Dockerfile', patchedDf) };
    const change = toolchainSpecChange({ original, patched, toRelease: '7.7.7' });
    const bsSpec = change.final['pipeline-bootstrap'].get('plugin-spec.yaml')!;
    expect(field(bsSpec, 'version')).toBe('7.7.7');
    expect(field(change.final['cdk-synth'].get('plugin-spec.yaml')!, 'version')).toBe('7.7.7');
    expect(change.final['cdk-synth'].get('Dockerfile')).toContain('ARG BOOTSTRAP_IMAGE="pipeline-bootstrap:7.7.7"');
    expect(change.sourceDigest.from).toBe(field(original['pipeline-bootstrap'].get('plugin-spec.yaml')!, 'sourceDigest'));
    expect(change.sourceDigest.to).toBe(toolchainSourceDigest(patched));
    expect(change.sourceDigest.to).not.toBe(change.sourceDigest.from);
    expect(field(bsSpec, 'sourceDigest')).toBe(change.sourceDigest.to);
    expect(change.toolchain).toEqual(toolchainFromDockerfile(bsDf));
    // The re-synced spec is a fixed point of the sync: its own digest still matches.
    expect(toolchainSourceDigest({ 'pipeline-bootstrap': change.final['pipeline-bootstrap'], 'cdk-synth': change.final['cdk-synth'] })).toBe(change.sourceDigest.to);
    expect(change.diff).toContain('--- a/deploy/toolchain/pipeline-bootstrap/Dockerfile');
    expect(change.diff).toContain('+++ b/deploy/toolchain/cdk-synth/plugin-spec.yaml');
    expect(change.diff).toContain('+version: 7.7.7');
    expect(change.diff).toContain(`+ARG NODE_IMAGE=node:26.13.1-slim@sha256:${'e'.repeat(64)}`);
    expect(change.diff).not.toContain('README.md');
  });
});

describe('edge inputs', () => {
  const ARGS = 'ARG PIPELINE_MANAGER_VERSION="1.0.0"\nARG AWS_CDK_VERSION=2.0.0\nARG CDK_ASSETS_VERSION="3.0.0"\nARG NODE_IMAGE=node:26.1.0-slim@sha256:' + 'a'.repeat(64) + '\n';

  it('reads unquoted and quoted ARGs; a duplicated or missing ARG makes the toolchain unreadable', () => {
    expect(toolchainFromDockerfile(ARGS)).toEqual({ pipelineManager: '1.0.0', awsCdk: '2.0.0', cdkAssets: '3.0.0', node: '26.1.0' });
    expect(toolchainFromDockerfile(`${ARGS}ARG AWS_CDK_VERSION=2.0.1\n`)).toBeNull();
    expect(toolchainFromDockerfile(ARGS.replace(/^ARG CDK_ASSETS_VERSION.*\n/m, ''))).toBeNull();
    expect(toolchainFromDockerfile(ARGS.replace('node:26.1.0-slim', 'node:lts-slim'))).toBeNull();
  });

  it('refreshes a CRLF Dockerfile without losing its line ending', async () => {
    const df = 'ARG NODE_IMAGE="node:26.1.0-slim@sha256:' + 'a'.repeat(64) + '"\r\nFROM ${NODE_IMAGE}\r\n';
    const r = await refreshNodeImage(df, async () => `sha256:${'f'.repeat(64)}`);
    expect(r!.dockerfile.split('\n')[0]).toBe(`ARG NODE_IMAGE="node:26.1.0-slim@sha256:${'f'.repeat(64)}"\r`);
    expect(await refreshNodeImage('FROM node:26\n', async () => `sha256:${'f'.repeat(64)}`)).toBeNull();
    expect(await refreshNodeImage(df, async () => 'not-a-digest')).toBeNull();
    expect(await refreshNodeImage(df, async () => { throw new Error('registry down'); })).toBeNull();
  });

  it('a candidate missing a spec or Dockerfile changes only what it has; no recorded digest reads null', () => {
    const tree = (files: Record<string, string>) => new Map(Object.entries(files));
    const change = toolchainSpecChange({
      original: { 'pipeline-bootstrap': tree({ Dockerfile: ARGS }), 'cdk-synth': tree({}) },
      patched: { 'pipeline-bootstrap': tree({ Dockerfile: ARGS }), 'cdk-synth': tree({}) },
      toRelease: '1.0.1',
    });
    expect(change.sourceDigest.from).toBeNull();
    expect(change.toolchain).toEqual(toolchainFromDockerfile(ARGS));
    expect([...change.final['cdk-synth'].keys()]).toEqual([]);
    expect(change.diff).toBe('');
    // An unreadable toolchain leaves the bootstrap spec untouched (verification refuses such a candidate anyway).
    const unreadable = toolchainSpecChange({
      original: { 'pipeline-bootstrap': tree({ 'plugin-spec.yaml': 'version: 1.0.0\n' }), 'cdk-synth': tree({}) },
      patched: { 'pipeline-bootstrap': tree({ 'plugin-spec.yaml': 'version: 1.0.0\n', 'Dockerfile': 'FROM x\n' }), 'cdk-synth': tree({}) },
      toRelease: '1.0.1',
    });
    expect(unreadable.toolchain).toBeNull();
    expect(unreadable.final['pipeline-bootstrap'].get('plugin-spec.yaml')).toBe('version: 1.0.0\n');
  });

  it('sorts input names by byte order, as `LC_ALL=C sort` does', () => {
    const t = (names: string[]) => ({ 'pipeline-bootstrap': new Map(names.map((n) => [n, 'x\n'])), 'cdk-synth': new Map<string, string>() });
    expect(toolchainSourceDigest(t(['b', 'B', 'a']))).toBe(toolchainSourceDigest(t(['a', 'B', 'b'])));
  });
});

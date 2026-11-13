// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline's toolchain release on the CLI side (plan §2, D2):
 *  - resolveBootstrapImage — the lookup it sends, and that EVERY failure is fatal;
 *  - fetchPipelineProps — the managed cdk-synth and the bootstrap carry the
 *    same releasePin, and halves from two releases are refused;
 *  - toolchain export ⇄ --toolchain-file round trip;
 *  - `pipeline deploy --local-spec` refuses without --toolchain-file and, with
 *    it, hands a synth-ready props object to the deploy (synthesized here for
 *    real through PipelineBuilder).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const WORK = mkdtempSync(join(tmpdir(), 'pm-toolchain-'));
process.env.HOME = WORK;
process.env.CLI_CONFIG_PATH = join(WORK, 'none.yml');

const mockRunDeploy = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/deploy-runner.js', () => ({
  __esModule: true,
  runDeploy: (...a: unknown[]) => mockRunDeploy(...a),
}));

const { Command } = await import('commander');
const { PluginResolutionError } = await import('../src/utils/plugin-resolver.js');
const {
  applyToolchainFile, exportToolchain, readToolchainFile, resolveBootstrapImage,
} = await import('../src/utils/toolchain.js');
const { fetchPipelineProps } = await import('../src/utils/pipeline-config.js');
const { deploy } = await import('../src/commands/deploy.js');
type ApiClient = import('../src/utils/api-client.js').ApiClient;

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const half = (name: string, version: string, c: string) => ({
  id: `id-${name}`,
  orgId: 'system',
  name,
  version,
  pluginType: name === 'cdk-synth' ? 'CodeBuildStep' : 'BuildImage',
  buildType: 'prebuilt',
  imageDigest: digest(c),
  imageRepository: `system/${name}`,
  commands: name === 'cdk-synth' ? ['pipeline-manager pipeline synth --id ${PIPELINE_ID} --store-tokens --quiet'] : [],
  installCommands: [],
  env: {},
  metadata: {},
  secrets: [],
  primaryOutputDirectory: name === 'cdk-synth' ? 'cdk.out' : null,
  computeType: 'SMALL',
  failureBehavior: 'fail',
});
const answer = (name: string, version: string, resolvedVia = 'default') => ({
  success: true,
  statusCode: 200,
  data: {
    plugin: half(name, version, name === 'cdk-synth' ? 'c' : 'b'),
    warnings: [],
    toolchain: { releaseVersion: version, resolvedVia, versions: { awsCdk: '2.1148.0', cdkAssets: '4.8.0' } },
  },
});

/** A client whose lookup answers per plugin name (and records every body). */
function lookupClient(answers: Record<string, unknown | Error>, bodies: Array<Record<string, unknown>> = [], pipeline?: unknown): ApiClient {
  return {
    getConfig: () => ({ api: { baseUrl: 'https://platform.example.com', pipelineUrl: 'https://platform.example.com/api/pipelines' } }),
    get: async () => pipeline,
    post: async (_url: string, body: Record<string, unknown>) => {
      bodies.push(body);
      const a = answers[(body.filter as { name: string }).name];
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as ApiClient;
}
const httpError = (status: number, code: string, message = code) =>
  Object.assign(new Error(message), { response: { status, data: { code, message } } });

describe('resolveBootstrapImage', () => {
  it('looks up pipeline-bootstrap with the pipeline\'s pin and the Build image step key', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const resolved = await resolveBootstrapImage(lookupClient({ 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.4.0', 'pin') }, bodies),
      { pipelineId: 'pipe-1', toolchain: { release: '1.4.0' } });
    expect(bodies).toEqual([{ filter: { name: 'pipeline-bootstrap' }, releasePin: '1.4.0', context: { pipelineId: 'pipe-1', stepKeys: ['build-image'] } }]);
    expect(resolved.plugin.name).toBe('pipeline-bootstrap');
    expect(resolved.toolchain).toEqual({ releaseVersion: '1.4.0', resolvedVia: 'pin', versions: { awsCdk: '2.1148.0', cdkAssets: '4.8.0' } });
  });

  it('sends no releasePin when the pipeline pins nothing', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await resolveBootstrapImage(lookupClient({ 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.1.0') }, bodies), {});
    expect(bodies[0]).toEqual({ filter: { name: 'pipeline-bootstrap' } });
  });

  it.each([
    ['409 TOOLCHAIN_NO_DEFAULT', httpError(409, 'TOOLCHAIN_NO_DEFAULT'), /no default toolchain release/],
    ['404 (deleted pin)', httpError(404, 'NOT_FOUND'), /release 9\.9\.9 does not exist/],
    ['a network failure', new Error('connect ECONNREFUSED'), /ECONNREFUSED/],
  ])('is FATAL (BOOTSTRAP_IMAGE_UNRESOLVED) on %s', async (_label, err, message) => {
    const run = resolveBootstrapImage(lookupClient({ 'pipeline-bootstrap': err }), { toolchain: { release: '9.9.9' } });
    await expect(run).rejects.toBeInstanceOf(PluginResolutionError);
    await expect(run).rejects.toMatchObject({ refusals: [{ plugin: 'pipeline-bootstrap', code: 'BOOTSTRAP_IMAGE_UNRESOLVED' }] });
    await expect(run).rejects.toThrow(message);
  });

  it('is FATAL on an answer without a record, or without a release', async () => {
    await expect(resolveBootstrapImage(lookupClient({ 'pipeline-bootstrap': { data: { plugin: null } } }), {})).rejects.toThrow(/no pipeline-bootstrap record/);
    await expect(resolveBootstrapImage(lookupClient({ 'pipeline-bootstrap': { data: { plugin: half('pipeline-bootstrap', '1.1.0', 'b') } } }), {}))
      .rejects.toThrow(/no toolchain release/);
  });

  it('refuses an answer for a different release than the pin', async () => {
    await expect(resolveBootstrapImage(lookupClient({ 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.3.0') }), { toolchain: { release: '1.4.0' } }))
      .rejects.toMatchObject({ refusals: [{ code: 'TOOLCHAIN_PAIR_MISMATCH' }] });
  });
});

describe('fetchPipelineProps — both halves from one release', () => {
  const PIPELINE = (release?: string) => ({
    id: 'pipe-1',
    orgId: 'org-1',
    project: 'shop',
    organization: 'acme',
    props: {
      project: 'shop',
      organization: 'acme',
      ...(release ? { toolchain: { release } } : {}),
      synth: { source: { type: 'github', options: { repo: 'acme/shop', branch: 'main' } }, plugin: { name: 'cdk-synth' } },
    },
  });

  it('the managed cdk-synth and the bootstrap carry the same releasePin; resolvedBootstrap lands on the props', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = lookupClient({ 'cdk-synth': answer('cdk-synth', '1.4.0', 'pin'), 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.4.0', 'pin') }, bodies, PIPELINE('1.4.0'));
    const { propsWithIds } = await fetchPipelineProps(client, 'pipe-1');
    const pins = Object.fromEntries(bodies.map((b) => [(b.filter as { name: string }).name, b.releasePin]));
    expect(pins).toEqual({ 'cdk-synth': '1.4.0', 'pipeline-bootstrap': '1.4.0' });
    expect((propsWithIds.resolvedBootstrap as { toolchain: { releaseVersion: string } }).toolchain.releaseVersion).toBe('1.4.0');
    expect((propsWithIds.resolvedPlugins as Record<string, { name: string }>)['cdk-synth-alias']!.name).toBe('cdk-synth');
  });

  it('refuses halves from two releases (TOOLCHAIN_PAIR_MISMATCH)', async () => {
    const client = lookupClient({ 'cdk-synth': answer('cdk-synth', '1.3.0'), 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.4.0') }, [], PIPELINE());
    await expect(fetchPipelineProps(client, 'pipe-1')).rejects.toMatchObject({ refusals: [{ code: 'TOOLCHAIN_PAIR_MISMATCH' }] });
  });

  it('a bootstrap failure stops the synth even when every plugin resolved', async () => {
    const client = lookupClient({ 'cdk-synth': answer('cdk-synth', '1.4.0'), 'pipeline-bootstrap': httpError(409, 'TOOLCHAIN_NO_DEFAULT') }, [], PIPELINE());
    await expect(fetchPipelineProps(client, 'pipe-1')).rejects.toMatchObject({ refusals: [{ code: 'BOOTSTRAP_IMAGE_UNRESOLVED' }] });
  });
});

describe('toolchain export ⇄ --toolchain-file', () => {
  it('exports both halves of one release and reads back as resolvedBootstrap + the synth plugin', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const file = await exportToolchain(lookupClient({ 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.4.0'), 'cdk-synth': answer('cdk-synth', '1.4.0') }, bodies));
    // No --release: the synth is pinned to the bootstrap's release so the halves match.
    expect(bodies.map((b) => [(b.filter as { name: string }).name, b.releasePin])).toEqual([['pipeline-bootstrap', undefined], ['cdk-synth', '1.4.0']]);
    expect(file).toMatchObject({
      format: 1,
      releaseVersion: '1.4.0',
      resolvedVia: 'default',
      platformBaseUrl: 'https://platform.example.com',
      toolchain: { awsCdk: '2.1148.0', cdkAssets: '4.8.0' },
      bootstrap: { name: 'pipeline-bootstrap', imageRepository: 'system/pipeline-bootstrap', imageDigest: digest('b') },
      synth: { name: 'cdk-synth', imageRepository: 'system/cdk-synth', imageDigest: digest('c') },
    });
    const path = join(WORK, 'tc.json');
    writeFileSync(path, JSON.stringify(file));
    const read = readToolchainFile(path);
    expect(read.bootstrap.toolchain.releaseVersion).toBe('1.4.0');
    expect(read.synth.name).toBe('cdk-synth');
  });

  it('sends --release to both halves', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await exportToolchain(lookupClient({ 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.2.0', 'pin'), 'cdk-synth': answer('cdk-synth', '1.2.0', 'pin') }, bodies), '1.2.0');
    expect(bodies.map((b) => b.releasePin)).toEqual(['1.2.0', '1.2.0']);
  });

  it.each([
    ['not JSON', 'nope'],
    ['no synth half', JSON.stringify({ format: 1, releaseVersion: '1.4.0', resolvedVia: 'default', toolchain: {}, bootstrap: { name: 'pipeline-bootstrap', version: '1.4.0', imageRepository: 'system/pipeline-bootstrap', imageDigest: digest('b'), plugin: half('pipeline-bootstrap', '1.4.0', 'b') } })],
  ])('refuses a file that is %s (BOOTSTRAP_IMAGE_UNRESOLVED)', (_label, content) => {
    const path = join(WORK, 'bad.json');
    writeFileSync(path, content);
    expect(() => readToolchainFile(path)).toThrow(PluginResolutionError);
    expect(() => readToolchainFile(path)).toThrow(/toolchain export/);
  });

  it('refuses a file for a different release than the pipeline pins', async () => {
    const file = await exportToolchain(lookupClient({ 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.4.0'), 'cdk-synth': answer('cdk-synth', '1.4.0') }));
    const path = join(WORK, 'tc-pin.json');
    writeFileSync(path, JSON.stringify(file));
    expect(() => applyToolchainFile({ toolchain: { release: '1.3.0' } }, path)).toThrow(/pins toolchain release 1\.3\.0/);
  });
});

describe('pipeline deploy --local-spec', () => {
  class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    mockRunDeploy.mockReset();
    for (const m of ['log', 'error', 'warn', 'info'] as const) {
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    }
    jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
    delete process.env.IMAGE_REGISTRY_PULL_HOST;
  });

  async function runDeployCommand(args: string[]): Promise<unknown> {
    const program = new Command();
    program.exitOverride();
    deploy(program.command('pipeline'));
    try {
      await program.parseAsync(['node', 'pm', 'pipeline', 'deploy', ...args]);
      return undefined;
    } catch (e) {
      return e;
    }
  }

  const spec = join(WORK, 'pipeline.json');
  writeFileSync(spec, JSON.stringify({
    id: 'pipe-local',
    orgId: 'org-1',
    project: 'shop',
    organization: 'acme',
    props: {
      project: 'shop',
      organization: 'acme',
      synth: { source: { type: 'github', options: { repo: 'acme/shop', branch: 'main' } }, plugin: { name: 'cdk-synth' } },
    },
  }));

  it('refuses without --toolchain-file, saying how to produce one', async () => {
    const err = await runDeployCommand(['--local-spec', spec]);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).not.toBe(0);
    expect(mockRunDeploy).not.toHaveBeenCalled();
    const out = logged.join('\n');
    expect(out).toMatch(/--toolchain-file/);
    expect(out).toMatch(/pipeline-manager toolchain export/);
  });

  it('with --toolchain-file, deploys props that synthesize on the release\'s images', async () => {
    const file = await exportToolchain(lookupClient({ 'pipeline-bootstrap': answer('pipeline-bootstrap', '1.4.0'), 'cdk-synth': answer('cdk-synth', '1.4.0') }));
    const tcPath = join(WORK, 'toolchain.json');
    writeFileSync(tcPath, JSON.stringify(file));

    const err = await runDeployCommand(['--local-spec', spec, '--toolchain-file', tcPath]);
    expect(err).toBeUndefined();
    expect(mockRunDeploy).toHaveBeenCalledTimes(1);
    const { propsWithIds } = mockRunDeploy.mock.calls[0]![0] as { propsWithIds: Record<string, unknown> };
    expect((propsWithIds.resolvedBootstrap as { toolchain: { releaseVersion: string } }).toolchain.releaseVersion).toBe('1.4.0');
    expect(propsWithIds.registry).toEqual({ pullHost: 'platform.example.com', pullPort: 443 });

    // The synth path: the props runDeploy would hand the boilerplate app build a real pipeline.
    const { App, Stack } = await import('aws-cdk-lib');
    const { Template } = await import('aws-cdk-lib/assertions');
    const { PipelineBuilder } = await import('@pipeline-builder/pipeline-core/cdk');
    const stack = new Stack(new App(), 'LocalSpec');
    new PipelineBuilder(stack, 'Pb', JSON.parse(JSON.stringify(propsWithIds)));
    const images = Object.values(Template.fromStack(stack).findResources('AWS::CodeBuild::Project'))
      .map((p) => (p as { Properties: { Environment: { Image: string } } }).Properties.Environment.Image);
    // The synth runs the exported cdk-synth half; self-mutation the curated image.
    expect(images).toContain(`platform.example.com/system/cdk-synth@${digest('c')}`);
    expect(images).toContain('aws/codebuild/standard:8.0');
    // And the same props without the release refuse to synthesize at all.
    const bare = JSON.parse(JSON.stringify(propsWithIds));
    delete bare.resolvedBootstrap;
    expect(() => new PipelineBuilder(new Stack(new App(), 'Bare'), 'Pb', bare)).toThrow(/BOOTSTRAP_IMAGE_UNRESOLVED.*resolvedBootstrap/);
  });

  it('refuses --toolchain-file without --local-spec', async () => {
    const err = await runDeployCommand(['--id', 'pipe-1', '--toolchain-file', 'x.json']);
    expect(err).toBeInstanceOf(ExitError);
    expect(mockRunDeploy).not.toHaveBeenCalled();
  });
});

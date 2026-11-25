// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const mockExecuteCdk = jest.fn<(...args: any[]) => { duration: number }>();
const mockSpawnCdk = jest.fn<(...args: any[]) => Promise<{ duration: number }>>();
const mockBuildRegistryPayload = jest.fn<(...args: any[]) => Promise<{ pipelineId: string }>>();
const mockWritePendingIntent = jest.fn<(...args: any[]) => Promise<string>>();
const mockReadStepManifest = jest.fn<(...args: any[]) => Promise<unknown[] | undefined>>();

jest.unstable_mockModule('../src/utils/cdk-utils.js', () => ({
  __esModule: true,
  executeCdkShellCommand: (...a: unknown[]) => mockExecuteCdk(...(a as [])),
  spawnCdkShellCommand: (...a: unknown[]) => mockSpawnCdk(...(a as [])),
  resolveBoilerplatePath: () => '/app/boilerplate.js',
}));
jest.unstable_mockModule('../src/utils/registry.js', () => ({
  __esModule: true,
  buildRegistryPayload: (...a: unknown[]) => mockBuildRegistryPayload(...(a as [])),
  writePendingIntent: (...a: unknown[]) => mockWritePendingIntent(...(a as [])),
  readStepManifest: (...a: unknown[]) => mockReadStepManifest(...(a as [])),
}));
// The deploy region: fixed here so no test reads the developer's ~/.aws.
const mockResolveDeployRegion = jest.fn<(...args: any[]) => Promise<string>>();
jest.unstable_mockModule('../src/utils/aws-env.js', () => ({
  __esModule: true,
  resolveDeployRegion: (...a: unknown[]) => mockResolveDeployRegion(...(a as [])),
}));
// Silence + avoid real fs (ensureOutputDirectory) during the test.
jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  ensureOutputDirectory: jest.fn<AnyFn>(),
  printInfo: jest.fn<AnyFn>(),
  printKeyValue: jest.fn<AnyFn>(),
  printSection: jest.fn<AnyFn>(),
  printSuccess: jest.fn<AnyFn>(),
  printWarning: jest.fn<AnyFn>(),
}));

const { runDeploy, registerPipeline } = await import('../src/utils/deploy-runner.js');

const PIPELINE = { id: 'p-1', orgId: 'org-1', pipelineName: 'acme-app', project: 'app', organization: 'acme' };
const BASE = {
  pipeline: PIPELINE,
  propsWithIds: { pipelineId: 'p-1', orgId: 'org-1' },
  requireApproval: 'never',
  output: 'cdk.out',
  executionId: 'exec-1',
};

describe('runDeploy: the runner deploy job\'s non-interactive path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteCdk.mockReturnValue({ duration: 5 });
    mockResolveDeployRegion.mockImplementation(async (override?: unknown) => override as string);
  });

  it('deploys the pre-synthesized assembly it is handed (the one the job inspected), never re-synthesizing', async () => {
    const register = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    await runDeploy({ ...BASE, region: 'eu-west-2', app: '/work/cdk.out', register });
    const command = mockExecuteCdk.mock.calls[0]![0] as string;
    expect(command).toContain("--app='/work/cdk.out'");
    expect(command).not.toContain('boilerplate');
    expect(command).toContain("--require-approval='never'");
  });

  it('registers through the given callback only: no platform registry POST, no pending intent', async () => {
    const register = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const post = jest.fn<(...args: any[]) => Promise<unknown>>();
    await runDeploy({ ...BASE, region: 'eu-west-2', register, platformClient: { post }, platformPipelineUrl: '/api/pipelines' });
    expect(register).toHaveBeenCalledWith({ region: 'eu-west-2', output: 'cdk.out' });
    expect(post).not.toHaveBeenCalled();
    expect(mockBuildRegistryPayload).not.toHaveBeenCalled();
    expect(mockWritePendingIntent).not.toHaveBeenCalled();
  });

  it('with a signal: cdk runs abortable (spawned, not execSync) and gets that signal', async () => {
    mockSpawnCdk.mockResolvedValue({ duration: 5 });
    const controller = new AbortController();
    const register = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    await runDeploy({ ...BASE, region: 'eu-west-2', app: '/work/cdk.out', register, signal: controller.signal });
    expect(mockExecuteCdk).not.toHaveBeenCalled();
    const [command, opts] = mockSpawnCdk.mock.calls[0]! as [string, { signal: AbortSignal; env: Record<string, string> }];
    expect(command).toContain("--app='/work/cdk.out'");
    expect(opts.signal).toBe(controller.signal);
    expect(opts.env.AWS_REGION).toBe('eu-west-2');
    expect(register).toHaveBeenCalled();
  });

  it('an aborted cdk run throws and never registers', async () => {
    mockSpawnCdk.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const register = jest.fn<(...args: any[]) => Promise<void>>();
    await expect(runDeploy({ ...BASE, region: 'eu-west-2', app: '/work/cdk.out', register, signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(register).not.toHaveBeenCalled();
  });

  it('a signal without a pre-synthesized app is refused (the props file must outlive the run)', async () => {
    await expect(runDeploy({ ...BASE, region: 'eu-west-2', signal: new AbortController().signal })).rejects.toThrow(/app/);
    expect(mockSpawnCdk).not.toHaveBeenCalled();
    expect(mockExecuteCdk).not.toHaveBeenCalled();
  });

  it('a CDK failure throws before the callback', async () => {
    mockExecuteCdk.mockImplementation(() => { throw new Error('cdk failed'); });
    const register = jest.fn<(...args: any[]) => Promise<void>>();
    await expect(runDeploy({ ...BASE, region: 'eu-west-2', register })).rejects.toThrow('cdk failed');
    expect(register).not.toHaveBeenCalled();
  });
});

describe('runDeploy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteCdk.mockReturnValue({ duration: 5 });
    mockBuildRegistryPayload.mockResolvedValue({ pipelineId: 'p-1' });
    mockWritePendingIntent.mockResolvedValue('/tmp/intent.json');
    mockReadStepManifest.mockResolvedValue(undefined);
    mockResolveDeployRegion.mockResolvedValue('eu-west-2');
  });

  // `cdk deploy` ran with NO region (so CDK used the profile's) while the
  // registry recorded resolveAwsRegion() — us-east-1 when the region lived only
  // in ~/.aws/config. Re-run then called CodePipeline in the wrong region:
  // "Pipeline not found in AWS" for a pipeline that was running fine.
  it('deploys AND registers in the ONE resolved region', async () => {
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockResolvedValue({});
    await runDeploy({ ...BASE, profile: 'work', region: undefined, platformClient: { post }, platformPipelineUrl: '/api/pipelines' });
    expect(mockResolveDeployRegion).toHaveBeenCalledWith(undefined, 'work');
    const env = (mockExecuteCdk.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env.AWS_REGION).toBe('eu-west-2');
    expect(env.AWS_DEFAULT_REGION).toBe('eu-west-2');
    expect(mockBuildRegistryPayload).toHaveBeenCalledWith(expect.anything(), 'eu-west-2');
  });

  it('an explicit --region is what both get', async () => {
    mockResolveDeployRegion.mockImplementation(async (override?: unknown) => (override as string) ?? 'x');
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockResolvedValue({});
    await runDeploy({ ...BASE, region: 'ap-southeast-2', platformClient: { post }, platformPipelineUrl: '/api/pipelines' });
    const env = (mockExecuteCdk.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env.AWS_REGION).toBe('ap-southeast-2');
    expect(mockBuildRegistryPayload).toHaveBeenCalledWith(expect.anything(), 'ap-southeast-2');
  });

  it('runs `cdk deploy` (with the approval level) then registers the ARN via the platform client', async () => {
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockResolvedValue({});
    await runDeploy({ ...BASE, platformClient: { post }, platformPipelineUrl: '/api/pipelines' });

    const cmd = mockExecuteCdk.mock.calls[0]![0] as string;
    expect(cmd).toContain('cdk deploy');
    // Interpolated values are shell-quoted (a space in a path/profile must not
    // split into extra cdk args).
    expect(cmd).toContain("--require-approval='never'");
    expect(cmd).toContain("--output='cdk.out'");
    // The props reach the CDK app as a file named in the env, never on the
    // command line or as an env value (E2BIG past 128 KiB on Linux).
    const env = (mockExecuteCdk.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env.PIPELINE_PROPS_FILE).toBeTruthy();
    expect(cmd).not.toContain(env.PIPELINE_PROPS_FILE!);
    expect(post).toHaveBeenCalledWith('/api/pipelines/registry', { pipelineId: 'p-1' });
  });

  it('hands the props over in a private file that is gone once cdk returns', async () => {
    let seen: { file: string; props: unknown; mode: number } | undefined;
    mockExecuteCdk.mockImplementation((_cmd: unknown, opts: unknown) => {
      const file = (opts as { env: Record<string, string> }).env.PIPELINE_PROPS_FILE!;
      seen = { file, props: JSON.parse(readFileSync(file, 'utf-8')), mode: statSync(file).mode % 0o1000 };
      return { duration: 5 };
    });
    await runDeploy(BASE);
    expect(seen!.props).toEqual(BASE.propsWithIds);
    expect(seen!.mode).toBe(0o600);
    expect(existsSync(seen!.file)).toBe(false);
  });

  it('removes the props file when cdk fails too', async () => {
    let file = '';
    mockExecuteCdk.mockImplementation((_cmd: unknown, opts: unknown) => {
      file = (opts as { env: Record<string, string> }).env.PIPELINE_PROPS_FILE!;
      throw new Error('cdk exit 1');
    });
    await expect(runDeploy(BASE)).rejects.toThrow(/cdk exit 1/);
    expect(existsSync(file)).toBe(false);
  });

  it('THROWS when the CDK deploy fails (so the caller exits non-zero) and never registers', async () => {
    mockExecuteCdk.mockImplementation(() => { throw new Error('cdk exit 1'); });
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockResolvedValue({});
    await expect(runDeploy({ ...BASE, platformClient: { post }, platformPipelineUrl: '/api/pipelines' }))
      .rejects.toThrow(/cdk exit 1/);
    expect(post).not.toHaveBeenCalled();
  });

  it('skips registration when no platform client is supplied (e.g. local-spec)', async () => {
    await runDeploy(BASE);
    expect(mockExecuteCdk).toHaveBeenCalled();
    expect(mockBuildRegistryPayload).not.toHaveBeenCalled();
  });

  it('queues a pending intent when the registry POST fails (deploy still succeeds)', async () => {
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockRejectedValue(new Error('503'));
    await expect(runDeploy({ ...BASE, platformClient: { post }, platformPipelineUrl: '/api/pipelines' }))
      .resolves.toBeUndefined();
    expect(mockWritePendingIntent).toHaveBeenCalledWith({ pipelineId: 'p-1' });
  });

  it('ships the synth step manifest from --output with the registration (and the pending intent)', async () => {
    const steps = [{ stageName: 'test-wave', actionName: 'jest', pluginId: 'pl-1', pluginName: 'jest', pluginVersion: '1.0.0', imageDigest: null }];
    mockReadStepManifest.mockResolvedValue(steps);
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockRejectedValue(new Error('503'));
    await runDeploy({ ...BASE, platformClient: { post }, platformPipelineUrl: '/api/pipelines' });
    expect(mockReadStepManifest).toHaveBeenCalledWith('cdk.out');
    expect(post).toHaveBeenCalledWith('/api/pipelines/registry', { pipelineId: 'p-1', steps });
    expect(mockWritePendingIntent).toHaveBeenCalledWith({ pipelineId: 'p-1', steps });
  });

  it('skips registration when the pipeline has no orgId', async () => {
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockResolvedValue({});
    await runDeploy({ ...BASE, pipeline: { ...PIPELINE, orgId: undefined }, platformClient: { post }, platformPipelineUrl: '/api/pipelines' });
    expect(mockBuildRegistryPayload).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('registerPipeline (the self-mutating synth\'s path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildRegistryPayload.mockResolvedValue({ pipelineId: 'p-1' });
    mockReadStepManifest.mockResolvedValue([{ stageName: 's', actionName: 'a', pluginId: 'x', pluginName: 'n', pluginVersion: '1', imageDigest: null, stepKey: 'n-alias' }]);
  });

  it('posts the step manifest and reports success', async () => {
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockResolvedValue({});
    await expect(registerPipeline({ client: { post }, pipelineUrl: '/api/pipelines', pipeline: PIPELINE, output: 'cdk.out', queueOnFailure: false }))
      .resolves.toBe(true);
    expect(post).toHaveBeenCalledWith('/api/pipelines/registry', expect.objectContaining({ steps: expect.any(Array) }));
  });

  it('never throws and never queues an intent inside CodeBuild (queueOnFailure=false)', async () => {
    const post = jest.fn<(...args: any[]) => Promise<unknown>>().mockRejectedValue(new Error('503'));
    await expect(registerPipeline({ client: { post }, pipelineUrl: '/api/pipelines', pipeline: PIPELINE, output: 'cdk.out', queueOnFailure: false }))
      .resolves.toBe(false);
    expect(mockWritePendingIntent).not.toHaveBeenCalled();
  });
});

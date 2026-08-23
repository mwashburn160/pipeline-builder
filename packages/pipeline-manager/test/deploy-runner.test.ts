// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockExecuteCdk = jest.fn<() => { success: boolean; duration: number }>();
const mockBuildRegistryPayload = jest.fn<() => Promise<{ pipelineId: string }>>();
const mockWritePendingIntent = jest.fn<() => Promise<string>>();

jest.unstable_mockModule('../src/utils/cdk-utils.js', () => ({
  __esModule: true,
  executeCdkShellCommand: (...a: unknown[]) => mockExecuteCdk(...(a as [])),
  resolveBoilerplatePath: () => '/app/boilerplate.js',
}));
jest.unstable_mockModule('../src/utils/registry.js', () => ({
  __esModule: true,
  buildRegistryPayload: (...a: unknown[]) => mockBuildRegistryPayload(...(a as [])),
  writePendingIntent: (...a: unknown[]) => mockWritePendingIntent(...(a as [])),
}));
// Silence + avoid real fs (ensureOutputDirectory) during the test.
jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  ensureOutputDirectory: jest.fn(),
  printInfo: jest.fn(),
  printKeyValue: jest.fn(),
  printSection: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
}));

const { runDeploy } = await import('../src/utils/deploy-runner.js');

const PIPELINE = { id: 'p-1', orgId: 'org-1', pipelineName: 'acme-app', project: 'app', organization: 'acme' };
const BASE = {
  pipeline: PIPELINE,
  propsWithIds: { pipelineId: 'p-1', orgId: 'org-1' },
  requireApproval: 'never',
  output: 'cdk.out',
  executionId: 'exec-1',
};

describe('runDeploy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteCdk.mockReturnValue({ success: true, duration: 5 });
    mockBuildRegistryPayload.mockResolvedValue({ pipelineId: 'p-1' });
    mockWritePendingIntent.mockResolvedValue('/tmp/intent.json');
  });

  it('runs `cdk deploy` (with the approval level) then registers the ARN via the platform client', async () => {
    const post = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
    await runDeploy({ ...BASE, platformClient: { post }, platformPipelineUrl: '/api/pipelines' });

    const cmd = mockExecuteCdk.mock.calls[0][0] as string;
    expect(cmd).toContain('cdk deploy');
    // Interpolated values are shell-quoted (a space in a path/profile must not
    // split into extra cdk args).
    expect(cmd).toContain("--require-approval='never'");
    expect(cmd).toContain("--output='cdk.out'");
    // PIPELINE_PROPS is passed base64 via env, not on the command line.
    const env = (mockExecuteCdk.mock.calls[0][1] as { env: Record<string, string> }).env;
    expect(env.PIPELINE_PROPS).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/api/pipelines/registry', { pipelineId: 'p-1' });
  });

  it('THROWS when the CDK deploy fails (so the caller exits non-zero) and never registers', async () => {
    mockExecuteCdk.mockImplementation(() => { throw new Error('cdk exit 1'); });
    const post = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
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
    const post = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('503'));
    await expect(runDeploy({ ...BASE, platformClient: { post }, platformPipelineUrl: '/api/pipelines' }))
      .resolves.toBeUndefined();
    expect(mockWritePendingIntent).toHaveBeenCalledWith({ pipelineId: 'p-1' });
  });

  it('skips registration when the pipeline has no orgId', async () => {
    const post = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
    await runDeploy({ ...BASE, pipeline: { ...PIPELINE, orgId: undefined }, platformClient: { post }, platformPipelineUrl: '/api/pipelines' });
    expect(mockBuildRegistryPayload).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

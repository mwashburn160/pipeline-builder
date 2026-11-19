// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline run` / `pipeline stop` with the operator's own credentials: the
 * registry says where the pipeline is, and its `pb.pipeline-id` tag must prove
 * it is that pipeline before anything is started or stopped.
 */

import { describe, it, expect } from '@jest/globals';
import { awsError, fakeSender, type SentCommand } from './helpers/runner-fixtures.js';

const { findRegistryLocation, resolveVerifiedPipeline, startPipelineRun, stopPipelineRun } = await import('../src/commands/pipeline-execution.js');
type ExecutionDeps = import('../src/commands/pipeline-execution.js').ExecutionDeps;

const ARN = 'arn:aws:codepipeline:eu-west-2:123456789012:acme-app-pipeline';

function deps(opts: { row?: Record<string, unknown> | null; tags?: Array<{ key: string; value: string }>; cp?: (n: string, i: any) => unknown } = {}) {
  const log: SentCommand[] = [];
  let fallback = 0;
  const d: ExecutionDeps = {
    locate: async () => (opts.row === null ? undefined : { pipelineId: 'pipe-1', pipelineName: 'acme-app-pipeline', region: 'eu-west-2', ...opts.row } as any),
    codepipeline: (region) => fakeSender((n, i) => {
      const custom = opts.cp?.(n, i);
      if (custom !== undefined) return custom;
      if (n === 'GetPipelineCommand') return { metadata: { pipelineArn: ARN } };
      if (n === 'ListTagsForResourceCommand') return { tags: opts.tags ?? [{ key: 'pb.pipeline-id', value: 'pipe-1' }] };
      if (n === 'StartPipelineExecutionCommand') return { pipelineExecutionId: 'exec-1' };
      return {};
    }, log, region),
    fallbackRegion: async () => { fallback += 1; return 'us-west-1'; },
    newToken: () => 'tok-1',
  };
  return { d, log, fallbackCalls: () => fallback };
}

describe('pipeline run', () => {
  it('checks the tag, then starts with a clientRequestToken in the registry region', async () => {
    const t = deps();
    expect(await startPipelineRun(t.d, 'pipe-1')).toEqual({ name: 'acme-app-pipeline', region: 'eu-west-2', executionId: 'exec-1' });
    expect(t.log.map((c) => c.name)).toEqual(['GetPipelineCommand', 'ListTagsForResourceCommand', 'StartPipelineExecutionCommand']);
    expect(t.log[1]!.input).toEqual({ resourceArn: ARN });
    expect(t.log[2]).toEqual({ name: 'StartPipelineExecutionCommand', input: { name: 'acme-app-pipeline', clientRequestToken: 'tok-1' }, region: 'eu-west-2' });
  });

  it('refuses a pipeline whose tag names another platform pipeline', async () => {
    const t = deps({ tags: [{ key: 'pb.pipeline-id', value: 'pipe-OTHER' }] });
    await expect(startPipelineRun(t.d, 'pipe-1')).rejects.toThrow(/different platform pipeline/);
    expect(t.log.map((c) => c.name)).not.toContain('StartPipelineExecutionCommand');
  });

  it('refuses an untagged pipeline (tags paged)', async () => {
    const t = deps({ cp: (n, i) => (n === 'ListTagsForResourceCommand' ? (i.nextToken ? { tags: [{ key: 'x', value: 'y' }] } : { tags: [], nextToken: 'n' }) : undefined) });
    await expect(startPipelineRun(t.d, 'pipe-1')).rejects.toThrow(/no pb.pipeline-id tag/);
    expect(t.log.filter((c) => c.name === 'ListTagsForResourceCommand')).toHaveLength(2);
    expect(t.log.map((c) => c.name)).not.toContain('StartPipelineExecutionCommand');
  });

  it('region: --region, else the registry row, else the resolveDeployRegion chain', async () => {
    const a = deps();
    expect((await resolveVerifiedPipeline(a.d, 'pipe-1', 'ap-south-1')).region).toBe('ap-south-1');
    const b = deps({ row: { region: null } });
    expect((await resolveVerifiedPipeline(b.d, 'pipe-1')).region).toBe('us-west-1');
    expect(b.fallbackCalls()).toBe(1);
    expect(a.fallbackCalls()).toBe(0);
  });

  it('an unregistered pipeline, or one not in this account, is a clear error', async () => {
    await expect(startPipelineRun(deps({ row: null }).d, 'pipe-1')).rejects.toThrow(/no deployment registered/);
    await expect(startPipelineRun(deps({ cp: (n) => (n === 'GetPipelineCommand' ? awsError('PipelineNotFoundException') : undefined) }).d, 'pipe-1'))
      .rejects.toThrow(/not found in eu-west-2/);
  });
});

describe('pipeline stop', () => {
  it('checks the tag and that the execution is this pipeline\'s, then stops it', async () => {
    const t = deps();
    expect(await stopPipelineRun(t.d, 'pipe-1', 'exec-9', { abandon: true })).toMatchObject({ executionId: 'exec-9' });
    expect(t.log.map((c) => c.name)).toEqual(['GetPipelineCommand', 'ListTagsForResourceCommand', 'GetPipelineExecutionCommand', 'StopPipelineExecutionCommand']);
    expect(t.log[3]!.input).toMatchObject({ pipelineName: 'acme-app-pipeline', pipelineExecutionId: 'exec-9', abandon: true });
  });

  it('refuses an execution of another pipeline', async () => {
    const t = deps({ cp: (n) => (n === 'GetPipelineExecutionCommand' ? awsError('PipelineExecutionNotFoundException') : undefined) });
    await expect(stopPipelineRun(t.d, 'pipe-1', 'exec-x')).rejects.toThrow(/does not belong/);
    expect(t.log.map((c) => c.name)).not.toContain('StopPipelineExecutionCommand');
  });

  it('refuses on a tag mismatch before looking at the execution', async () => {
    const t = deps({ tags: [{ key: 'pb.pipeline-id', value: 'nope' }] });
    await expect(stopPipelineRun(t.d, 'pipe-1', 'e')).rejects.toThrow(/different/);
    expect(t.log.map((c) => c.name)).toEqual(['GetPipelineCommand', 'ListTagsForResourceCommand']);
  });
});

describe('findRegistryLocation', () => {
  it('pages the registry until it finds the pipeline', async () => {
    const pages = [
      { registry: [{ pipelineId: 'a', pipelineName: 'x' }], pagination: { hasMore: true } },
      { registry: [{ pipelineId: 'pipe-1', pipelineName: 'acme', region: 'us-east-1' }], pagination: { hasMore: false } },
    ];
    const offsets: unknown[] = [];
    const client = { get: async (_u: string, p?: Record<string, unknown>) => { offsets.push(p?.offset); return { success: true, data: pages[offsets.length - 1] } as any; } };
    expect(await findRegistryLocation(client, '/api/pipelines', 'pipe-1')).toMatchObject({ pipelineName: 'acme', region: 'us-east-1' });
    expect(offsets).toEqual([0, 1]);
    expect(await findRegistryLocation({ get: async () => ({ registry: [], pagination: { hasMore: false } }) as any }, '/p', 'z')).toBeUndefined();
  });
});

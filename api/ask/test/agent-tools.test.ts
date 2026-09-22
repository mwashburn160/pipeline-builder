// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the agent tool set. Focus: every tool acts via the forwarded user token,
 * and propose_* tools only DRAFT — they never call a create endpoint.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

// Mock ai-core: real-ish `tool`/`buildGroundingContext`, mocked `generateObject`.
const mockGenerateObject = jest.fn<(...a: unknown[]) => Promise<{ object: unknown }>>();
jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', {
  tool: (def: unknown) => def,
  buildGroundingContext: (hits: Array<{ doc: { title?: string; text: string } }>) => hits.map((h) => `${h.doc.title}: ${h.doc.text}`).join('\n'),
  generateObject: mockGenerateObject,
}));

const { buildAgentTools } = await import('../src/services/agent-tools.js');

const search = jest.fn((..._args: unknown[]) => [
  { doc: { id: 'deployment.md#x', title: 'Deploy', url: 'docs/deployment', text: 'Deploy steps here.' }, score: 1 },
]);
const index = { size: 1, search } as never;
const pipeline = { get: jest.fn<AnyFn>(), post: jest.fn<AnyFn>() };
const plugin = { get: jest.fn<AnyFn>(), post: jest.fn<AnyFn>() };
const model = { id: 'm' } as never;

const chargeAiCall = jest.fn<() => Promise<boolean>>(async () => true);
const makeTools = () =>
  buildAgentTools({ index, pipeline: pipeline as never, plugin: plugin as never, model, defaults: { provider: 'anthropic', model: 'claude-sonnet-5' }, orgId: 'o', chargeAiCall, maxOutputTokens: 512 }) as Record<string, {
    execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>>;
    inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  }>;

const call = (name: string, input: unknown) => makeTools()[name].execute(input, {});

describe('buildAgentTools', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('answer_how_to returns grounded context + sources', async () => {
    const out = await call('answer_how_to', { query: 'how do I deploy' });
    expect(search).toHaveBeenCalledWith('how do I deploy', 5);
    expect(String(out.context)).toContain('Deploy steps here.');
    expect((out.sources as Array<{ id: string }>)[0].id).toBe('deployment.md#x');
  });

  it('list_pipelines reads GET /pipelines (user token)', async () => {
    pipeline.get.mockResolvedValue({ data: [{ id: 'p1' }] });
    const out = await call('list_pipelines', {});
    expect(pipeline.get).toHaveBeenCalledWith('/pipelines');
    expect(out.pipelines).toEqual([{ id: 'p1' }]);
  });

  it('inspect_pipeline reads GET /pipelines/:id (user token)', async () => {
    pipeline.get.mockResolvedValue({ data: { id: 'p1', name: 'x' } });
    const out = await call('inspect_pipeline', { id: 'p1' });
    expect(pipeline.get).toHaveBeenCalledWith('/pipelines/p1');
    expect(out.pipeline).toEqual({ id: 'p1', name: 'x' });
  });

  it('propose_pipeline DRAFTS via /generate and never calls a create endpoint', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { name: 'x' }, description: 'd' } });
    const out = await call('propose_pipeline', { prompt: 'ci for a node app' });
    expect(pipeline.post).toHaveBeenCalledWith('/pipelines/generate', { prompt: 'ci for a node app', provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(out).toEqual({ kind: 'pipeline', props: { name: 'x' }, description: 'd' });
    expect(pipeline.post.mock.calls.map((c: unknown[]) => c[0])).not.toContain('/pipelines');
  });

  it('propose_pipeline passes the generated keywords through to the draft', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { name: 'x' }, description: 'd', keywords: ['node', 'ci'] } });
    const out = await call('propose_pipeline', { prompt: 'ci for a node app' });
    expect(out.keywords).toEqual(['node', 'ci']);
  });

  it('propose_pipeline_from_repo DRAFTS via /generate/from-url with the repo token from the REQUEST', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { name: 'x' }, description: 'd', keywords: ['node'], analysis: { repo: 'app' } } });
    const tools = buildAgentTools({
      index,
      pipeline: pipeline as never,
      plugin: plugin as never,
      model,
      defaults: { provider: 'anthropic', model: 'claude-sonnet-5', repoToken: 'ghp_secret' },
      orgId: 'o',
      chargeAiCall,
      maxOutputTokens: 512,
    }) as unknown as Record<string, { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>>; inputSchema: { shape: Record<string, unknown> } }>;
    const out = await tools.propose_pipeline_from_repo.execute({ gitUrl: 'https://github.com/o/app' }, {});
    expect(pipeline.post).toHaveBeenCalledWith('/pipelines/generate/from-url', {
      gitUrl: 'https://github.com/o/app', provider: 'anthropic', model: 'claude-sonnet-5', repoToken: 'ghp_secret',
    });
    expect(out).toEqual({ kind: 'pipeline', props: { name: 'x' }, description: 'd', keywords: ['node'], analysis: { repo: 'app' } });
    // The model can only supply the URL — the token is never a tool input it can see or set.
    expect(Object.keys(tools.propose_pipeline_from_repo.inputSchema.shape)).toEqual(['gitUrl']);
  });

  it('propose_plugin DRAFTS via plugin /generate (config + dockerfile), never deploys', async () => {
    plugin.post.mockResolvedValue({ data: { config: { name: 'trivy' }, dockerfile: 'FROM x' } });
    const out = await call('propose_plugin', { prompt: 'trivy image scan' });
    expect(plugin.post).toHaveBeenCalledWith('/plugins/generate', { prompt: 'trivy image scan', provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(out).toEqual({ kind: 'plugin', config: { name: 'trivy' }, dockerfile: 'FROM x' });
    expect(plugin.post.mock.calls.map((c: unknown[]) => c[0])).not.toContain('/plugins/deploy-generated');
  });

  it('list_templates lists templates (with inputs) via GET /pipeline-templates', async () => {
    pipeline.get.mockResolvedValue({ data: [{ id: 't1', inputs: [{ name: 'region' }] }] });
    const out = await call('list_templates', {});
    expect(pipeline.get).toHaveBeenCalledWith('/pipeline-templates');
    expect(out.templates).toEqual([{ id: 't1', inputs: [{ name: 'region' }] }]);
  });

  it('propose_pipeline_from_template instantiates a template, injecting the AUTHENTICATED org (not a model-supplied one)', async () => {
    pipeline.post.mockResolvedValue({ data: { props: { project: 'p', organization: 'o', synth: {} }, description: 'from template' } });
    // The model does NOT supply `organization`; even if a crafted input tried to,
    // the tool ignores it and uses the caller's org (`orgId: 'o'` from deps).
    const out = await call('propose_pipeline_from_template', {
      templateId: 't1', project: 'p', organization: 'attacker-org', inputs: { region: 'us-east-1' },
    });
    expect(pipeline.post).toHaveBeenCalledWith('/pipeline-templates/t1/instantiate', {
      project: 'p', organization: 'o', inputs: { region: 'us-east-1' },
    });
    expect(out).toEqual({ kind: 'pipeline', props: { project: 'p', organization: 'o', synth: {} }, description: 'from template' });
    // never hits a create endpoint
    expect(pipeline.post.mock.calls.map((c: unknown[]) => c[0])).not.toContain('/pipelines');
  });

  it('propose_template drafts a template via generateObject (no create)', async () => {
    mockGenerateObject.mockResolvedValue({ object: { name: 'node-ci', props: { steps: '{{ vars.CMD }}' }, inputs: [{ name: 'CMD' }] } });
    const out = await call('propose_template', { prompt: 'reusable node CI' });
    expect(mockGenerateObject).toHaveBeenCalled();
    expect(out).toEqual({ kind: 'template', template: { name: 'node-ci', props: { steps: '{{ vars.CMD }}' }, inputs: [{ name: 'CMD' }] } });
    // never touches an HTTP create endpoint
    expect(pipeline.post).not.toHaveBeenCalled();
  });

  it('propose_template CHARGES its own aiCalls slot and caps output tokens', async () => {
    mockGenerateObject.mockResolvedValue({ object: { name: 't', props: {} } });
    await call('propose_template', { prompt: 'reusable node CI' });
    expect(chargeAiCall).toHaveBeenCalledTimes(1);
    expect(mockGenerateObject).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 512 }));
  });

  it('propose_template declines WITHOUT generating when the org is out of aiCalls', async () => {
    chargeAiCall.mockResolvedValueOnce(false);
    const out = await call('propose_template', { prompt: 'reusable node CI' });
    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'template', error: expect.stringContaining('quota') });
  });

  it('model-supplied ids that land in a URL path reject `..` and slashes', () => {
    const tools = makeTools();
    for (const bad of ['..', '../admin', 'a/b', 'a%2Fb', '', 'x'.repeat(200)]) {
      expect(tools.inspect_pipeline.inputSchema.safeParse({ id: bad }).success).toBe(false);
      expect(tools.propose_pipeline_from_template.inputSchema.safeParse({ templateId: bad, project: 'p' }).success).toBe(false);
    }
    expect(tools.inspect_pipeline.inputSchema.safeParse({ id: '6f1c2a3b-0000-4000-8000-000000000000' }).success).toBe(true);
  });
});

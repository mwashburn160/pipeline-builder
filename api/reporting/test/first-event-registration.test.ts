// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reporting's client for the pipeline service's first-event registration.
 *
 * FAIL-SAFE is the point: whatever goes wrong — unreachable, a non-2xx, a reply
 * that does not match the contract — the answer is "nothing registered", so the
 * ingest keeps skipping (and counting) those events exactly as before. And the
 * call is made with the system-org reporting token, carrying the caller's
 * allow-list in the body: the endpoint confines itself to that list.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockPost = jest.fn<AnyFn>();
const mockServiceAuth = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: class {
    post = (...a: unknown[]) => mockPost(...a);
  },
  getServiceAuthHeader: (...a: unknown[]) => {
    mockServiceAuth(...a);
    return 'Bearer service-token';
  },
}));

const { registerFirstEventPipelines } = await import('../src/services/first-event-registration.js');
const { SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');

const PID = '11111111-1111-4111-8111-111111111111';
// An org id in the contract's shape (24 hex): it refuses anything else.
const ORG = 'a1b2c3d4e5f6a1b2c3d4e5f6';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registerFirstEventPipelines', () => {
  it('posts the candidates and allow-list to the contract path and returns what registered', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, body: { data: { registered: [PID] } } });
    await expect(registerFirstEventPipelines([{ pipelineId: PID, region: 'us-east-1' }], [ORG])).resolves.toEqual([PID]);
    expect(mockPost).toHaveBeenCalledWith(
      '/pipelines/internal/registry/first-event',
      { allowedOrgIds: [ORG], pipelines: [{ pipelineId: PID, region: 'us-east-1' }] },
      expect.objectContaining({ headers: { Authorization: 'Bearer service-token' } }),
    );
    expect(mockServiceAuth).toHaveBeenCalledWith({ serviceName: 'reporting', orgId: SYSTEM_ORG_ID, role: 'member' });
  });

  it('answers nothing registered when the pipeline service is unreachable', async () => {
    mockPost.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], [ORG])).resolves.toEqual([]);
  });

  it('answers nothing registered on a non-2xx', async () => {
    mockPost.mockResolvedValue({ statusCode: 500, body: {} });
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], [ORG])).resolves.toEqual([]);
  });

  it('answers nothing registered on a reply outside the contract', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, body: { data: { registered: 'all of them' } } });
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], [ORG])).resolves.toEqual([]);
  });

  it('makes no call with no candidates or no allowed org', async () => {
    await expect(registerFirstEventPipelines([], [ORG])).resolves.toEqual([]);
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], [])).resolves.toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('splits more candidates than the contract takes per call into several calls (MAX_EVENTS_PER_BATCH is tunable past it)', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`);
    mockPost.mockImplementation(async (_path: unknown, body: unknown) => ({
      statusCode: 200,
      body: { data: { registered: (body as { pipelines: Array<{ pipelineId: string }> }).pipelines.map((p) => p.pipelineId) } },
    }));
    await expect(registerFirstEventPipelines(ids.map((pipelineId) => ({ pipelineId })), [ORG])).resolves.toEqual(ids);
    expect(mockPost).toHaveBeenCalledTimes(2);
    const sizes = mockPost.mock.calls.map((c) => ((c as unknown[])[1] as { pipelines: unknown[] }).pipelines.length);
    expect(sizes).toEqual([100, 50]);
  });

  it('splits a roll-up larger than the contract\'s org cap into several allow-lists, and registers across them', async () => {
    // 1500 orgs: one call naming them all is a 400 (the contract takes 1000).
    const orgs = Array.from({ length: 1500 }, (_, i) => i.toString(16).padStart(24, '0'));
    const PID2 = '22222222-2222-4222-8222-222222222222';
    const ownerOf: Record<string, string> = { [PID]: orgs[10], [PID2]: orgs[1200] };
    mockPost.mockImplementation(async (_path: unknown, body: unknown) => {
      const b = body as { allowedOrgIds: string[]; pipelines: Array<{ pipelineId: string }> };
      if (b.allowedOrgIds.length > 1000) return { statusCode: 400, body: {} };
      return { statusCode: 200, body: { data: { registered: b.pipelines.map((p) => p.pipelineId).filter((id) => b.allowedOrgIds.includes(ownerOf[id])) } } };
    });
    const out = await registerFirstEventPipelines([{ pipelineId: PID }, { pipelineId: PID2 }], orgs);
    expect([...out].sort()).toEqual([PID, PID2]);
    for (const c of mockPost.mock.calls) {
      const b = (c as unknown[])[1] as { allowedOrgIds: string[]; pipelines: Array<{ pipelineId: string }> };
      expect(b.allowedOrgIds.length).toBeLessThanOrEqual(1000);
    }
    // A pipeline the first allow-list registered is not offered again under the next.
    const second = (mockPost.mock.calls[1] as unknown[])[1] as { pipelines: Array<{ pipelineId: string }> };
    expect(second.pipelines.map((p) => p.pipelineId)).toEqual([PID2]);
  });
});

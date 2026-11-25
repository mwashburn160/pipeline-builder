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

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registerFirstEventPipelines', () => {
  it('posts the candidates and allow-list to the contract path and returns what registered', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, body: { data: { registered: [PID] } } });
    await expect(registerFirstEventPipelines([{ pipelineId: PID, region: 'us-east-1' }], ['acme'])).resolves.toEqual([PID]);
    expect(mockPost).toHaveBeenCalledWith(
      '/pipelines/internal/registry/first-event',
      { allowedOrgIds: ['acme'], pipelines: [{ pipelineId: PID, region: 'us-east-1' }] },
      expect.objectContaining({ headers: { Authorization: 'Bearer service-token' } }),
    );
    expect(mockServiceAuth).toHaveBeenCalledWith({ serviceName: 'reporting', orgId: SYSTEM_ORG_ID, role: 'member' });
  });

  it('answers nothing registered when the pipeline service is unreachable', async () => {
    mockPost.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], ['acme'])).resolves.toEqual([]);
  });

  it('answers nothing registered on a non-2xx', async () => {
    mockPost.mockResolvedValue({ statusCode: 500, body: {} });
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], ['acme'])).resolves.toEqual([]);
  });

  it('answers nothing registered on a reply outside the contract', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, body: { data: { registered: 'all of them' } } });
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], ['acme'])).resolves.toEqual([]);
  });

  it('makes no call with no candidates or no allowed org', async () => {
    await expect(registerFirstEventPipelines([], ['acme'])).resolves.toEqual([]);
    await expect(registerFirstEventPipelines([{ pipelineId: PID }], [])).resolves.toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

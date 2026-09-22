// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `requireIngestScope` — the single per-route guard shared by every
 * reporting machine write (events, ingest-health, incident webhooks). Router
 * suites cover that each route mounts it (their 403 cases run the full chain).
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSendError = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: mockSendError,
  hasScope: (req: any, scope: string) => req?.user?.scope === scope,
}));

const { requireIngestScope, INGEST_SCOPE } = await import('../src/middleware/require-ingest-scope.js');

describe('requireIngestScope', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const run = (user: unknown) => {
    const next = jest.fn<AnyFn>();
    requireIngestScope({ user } as any, {} as any, next);
    return next;
  };

  it('guards the reporting:ingest scope', () => {
    expect(INGEST_SCOPE).toBe('reporting:ingest');
  });

  it('calls next() for a reporting:ingest-scoped token', () => {
    const next = run({ sub: 'svc', scope: 'reporting:ingest' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockSendError).not.toHaveBeenCalled();
  });

  it('calls next() for a SERVICE-ACCOUNT key token carrying the scope (#12/#N2)', () => {
    // What the AWS events Lambda actually presents after trading its `pb_sa_…`
    // key: a service-account principal, `token_use: 'api_key'`, no permissions at
    // all, and the one scope. The gate keys on the scope, not the principal kind.
    const next = run({
      sub: 'sa-1',
      principalType: 'service_account',
      token_use: 'api_key',
      scope: 'reporting:ingest',
      permissions: [],
      organizationId: 'acme',
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockSendError).not.toHaveBeenCalled();
  });

  it.each([
    ['a token with a different scope', { sub: 'svc', scope: 'reporting:read' }],
    ['a REGISTRY-scoped service-account token', {
      sub: 'sa-2', principalType: 'service_account', token_use: 'api_key', scope: 'registry:push',
    }],
    ['an UNSCOPED service-account token holding the org admin role', {
      sub: 'sa-3',
      principalType: 'service_account',
      token_use: 'api_key',
      isAdmin: true,
      permissions: ['pipelines:write'],
    }],
    ['a plain user token (no scope)', { sub: 'u-1', isSuperAdmin: true }],
    ['no user at all', undefined],
  ])('403s %s without calling next()', (_label, user) => {
    const next = run(user);
    expect(next).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(
      expect.anything(), 403, expect.stringContaining('reporting:ingest'), 'INSUFFICIENT_PERMISSIONS');
  });
});

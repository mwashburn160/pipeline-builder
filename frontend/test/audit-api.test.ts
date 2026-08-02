// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * URL-contract tests for the audit admin-API methods. The hash-chain verify
 * endpoint (`GET /api/audit/verify?orgId=…`) is sysadmin-only and had no
 * client method before; these assertions lock its path + query shape so a
 * future refactor can't silently drop the `orgId` param.
 */

import type { ApiCore } from '../src/lib/api/core';
import { adminApi } from '../src/lib/api/domains/admin';

// Capture every path adminApi hands to core.request. adminApi only touches
// `core.request` for these methods, so a minimal fake is sufficient.
function makeApi() {
  const calls: string[] = [];
  const core = {
    request: jest.fn((path: string) => {
      calls.push(path);
      return Promise.resolve({ success: true, data: {} });
    }),
  } as unknown as ApiCore;
  return { api: adminApi(core), calls };
}

describe('verifyAuditChain', () => {
  it('GETs /api/audit/verify with the orgId as a query param', async () => {
    const { api, calls } = makeApi();
    await api.verifyAuditChain('org-123');
    expect(calls).toHaveLength(1);
    const [path, query] = calls[0].split('?');
    expect(path).toBe('/api/audit/verify');
    expect(new URLSearchParams(query).get('orgId')).toBe('org-123');
  });

  it('url-encodes an orgId that needs escaping', async () => {
    const { api, calls } = makeApi();
    await api.verifyAuditChain('org/with space');
    const query = calls[0].split('?')[1];
    expect(new URLSearchParams(query).get('orgId')).toBe('org/with space');
  });
});

describe('listAuditEvents (kept intact by the type consolidation)', () => {
  it('GETs /api/audit and forwards filter params', async () => {
    const { api, calls } = makeApi();
    await api.listAuditEvents({ action: 'authz.denied', outcome: 'failure' });
    const [path, query] = calls[0].split('?');
    expect(path).toBe('/api/audit');
    const params = new URLSearchParams(query);
    expect(params.get('action')).toBe('authz.denied');
    expect(params.get('outcome')).toBe('failure');
  });

  it('forwards the createdAt from/to range params', async () => {
    const { api, calls } = makeApi();
    await api.listAuditEvents({ from: '2026-07-01', to: '2026-07-31' });
    const query = calls[0].split('?')[1];
    const params = new URLSearchParams(query);
    expect(params.get('from')).toBe('2026-07-01');
    expect(params.get('to')).toBe('2026-07-31');
  });
});

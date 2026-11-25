// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /internal/plugins/orgs/:orgId/lookup — the pipeline service's deploy-job
 * lookup. Pins: only the `pipeline` service principal reaches the handler; the
 * lookup runs as the PATH org (normalised as the public route's identity org
 * is), with its parent, under that org's own non-elevated, viewer-less tenant
 * scope (so no member's private plugin resolves), the parent carried in the
 * tenant context exactly as the public chain carries it; an unreadable org
 * hierarchy fails closed (503) without resolving anything.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.JWT_SECRET ||= 'internal-deploy-lookup-test-secret';
process.env.PLUGIN_UPLOAD_DIR ||= mkdtempSync(join(tmpdir(), 'plugin-deploy-lookup-'));

const mockParent = jest.fn<(orgId: string, opts?: unknown) => Promise<string | undefined>>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ fetchParentOrgId: mockParent }));

const { getTenantContext } = await import('@pipeline-builder/pipeline-data');
const seen: Array<{ args: unknown[]; tenant: unknown }> = [];
const mockLookup = jest.fn((...args: unknown[]) => {
  seen.push({ args, tenant: { ...getTenantContext() } });
  const res = args[2] as { status: (n: number) => { json: (b: unknown) => unknown } };
  return res.status(200).json({ success: true, data: { plugin: { name: 'lint', version: '1.0.0' }, warnings: [] } });
});
jest.unstable_mockModule('../src/routes/read-plugins.js', () => ({ lookupFromBody: mockLookup }));

const { createInternalRoutes } = await import('../src/routes/internal.js');

type Res = { statusCode?: number; body?: { message?: string; code?: string }; status: (n: number) => Res; json: (b: unknown) => Res; setHeader: () => void };
function makeRes(): Res {
  const res: Res = {
    status(n: number) { res.statusCode = n; return res; },
    json(b: unknown) { res.body = b as never; return res; },
    setHeader() { /* irrelevant */ },
  };
  return res;
}

const layer = (createInternalRoutes().stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }>)
  .find((l) => l.route?.path === '/plugins/orgs/:orgId/lookup' && l.route.methods.post)!;
const [gate, handler] = [layer.route!.stack[0]!.handle, layer.route!.stack[layer.route!.stack.length - 1]!.handle];

const service = (serviceName: string) => ({ principalType: 'service', serviceName, sub: `service:${serviceName}`, organizationId: 'system' });
const body = { filter: { name: 'lint' } };
/** The request context `attachRequestContext` gives a service-token request. */
const context = () => ({ identity: { orgId: 'system', userId: '' }, requestId: 'req-1', log: () => undefined });

beforeEach(() => {
  jest.clearAllMocks();
  seen.length = 0;
  mockParent.mockResolvedValue('Parent-Org');
});

describe('POST /internal/plugins/orgs/:orgId/lookup', () => {
  it('admits only the pipeline service principal', () => {
    expect(layer.route!.stack).toHaveLength(2);
    for (const user of [undefined, service('reporting'), { sub: 'u-1', organizationId: 'acme', role: 'owner' }]) {
      const res = makeRes();
      const next = jest.fn();
      gate({ user, method: 'POST', originalUrl: '/internal/plugins/orgs/acme/lookup', headers: {} }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect([401, 403]).toContain(res.statusCode);
    }
    const next = jest.fn();
    gate({ user: service('pipeline'), method: 'POST', originalUrl: '/internal/plugins/orgs/acme/lookup', headers: {} }, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('resolves as the path org with its parent, in that org\'s own viewer-less, non-elevated scope', async () => {
    const res = makeRes();
    await handler({ params: { orgId: ' ACME ' }, body, headers: {}, user: service('pipeline'), context: context() }, res);
    expect(res.statusCode).toBe(200);
    expect(mockParent).toHaveBeenCalledWith('acme', { throwOnHttpError: true });
    expect(mockLookup).toHaveBeenCalledTimes(1);
    const [b, parentOrgId, , orgId] = seen[0]!.args;
    expect(b).toEqual(body);
    expect(parentOrgId).toBe('parent-org');
    expect(orgId).toBe('acme');
    // The tenant scope the public chain sets for a team member, minus the user.
    expect(seen[0]!.tenant).toEqual({ orgId: 'acme', isSuperAdmin: false, parentOrgId: 'parent-org' });
  });

  it('a root org resolves with no parent', async () => {
    mockParent.mockResolvedValue(undefined);
    const res = makeRes();
    await handler({ params: { orgId: 'acme' }, body, headers: {}, user: service('pipeline'), context: context() }, res);
    expect(seen[0]!.args[1]).toBeUndefined();
    expect(seen[0]!.tenant).toEqual({ orgId: 'acme', isSuperAdmin: false });
  });

  it('fails closed (503) when the org hierarchy is unreadable, resolving nothing', async () => {
    mockParent.mockRejectedValue(new Error('HTTP 502'));
    const res = makeRes();
    await handler({ params: { orgId: 'acme' }, body, headers: {}, user: service('pipeline'), context: context() }, res);
    expect(res.statusCode).toBe(503);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('400s a blank org id without resolving', async () => {
    for (const orgId of ['', '   ']) {
      const res = makeRes();
      await handler({ params: { orgId }, body, headers: {}, user: service('pipeline'), context: context() }, res);
      expect(res.statusCode).toBe(400);
    }
    expect(mockParent).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });
});

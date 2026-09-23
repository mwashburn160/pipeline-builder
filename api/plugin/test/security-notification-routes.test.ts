// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin security notification route handlers (routes/security-notifications.ts):
 * each hands the caller's org / user and body to the service and answers with
 * the result; `canEdit` follows `org:settings`; the anonymous confirmation takes
 * the token from the body. The gates themselves (plugins:read / org:settings,
 * the anonymous waiver) are checked against the real route table in route-coverage.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, statusCode: number, data?: unknown, message?: string) => res.status(statusCode).json({ success: true, data, ...(message ? { message } : {}) }),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  rateLimitByOrg: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  withRoute: (fn: (a: unknown) => Promise<void>) => async (rq: any, rs: any) => {
    try {
      await fn({ req: rq, res: rs, ctx: { log: jest.fn<AnyFn>() } });
    } catch (err: any) {
      if (typeof err.statusCode === 'number' && err.code) {
        rs.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
        return;
      }
      rs.status(500).json({ success: false, message: err.message });
    }
  },
}));

const svc = {
  getSecurityPrefs: jest.fn(async (_org: string, canEdit: boolean) => ({ recipientMode: 'writers', canEdit })),
  putSecurityPrefs: jest.fn(async (..._a: unknown[]): Promise<unknown> => ({ recipientMode: 'users' })),
  sendTestNotice: jest.fn(async (..._a: unknown[]) => ({ relay: 'sent', webhook: null, externalEmail: 'none' })),
  confirmExternalEmail: jest.fn(async (..._a: unknown[]) => ({ confirmed: true })),
};
jest.unstable_mockModule('../src/services/plugin-security-notifications.js', () => svc);

const { createSecurityNotificationRoutes, createPublicSecurityNotificationRoutes } = await import('../src/routes/security-notifications.js');
const { EcosystemError } = await import('../src/services/ecosystem/context.js');

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: any[]) => any }> } };

async function call(router: unknown, method: string, path: string, req: Record<string, unknown> = {}) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handlers = layer.route!.stack.map((s) => s.handle);
  const res: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  const request = {
    params: {},
    query: {},
    body: {},
    headers: {},
    user: { sub: 'u-1', organizationId: 'ORG-A', principalType: 'user', permissions: ['plugins:read'], features: [] },
    ...req,
  };
  await handlers[handlers.length - 1]!(request, res, () => undefined);
  return res;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('org routes', () => {
  const router = createSecurityNotificationRoutes();

  it('GET reads the caller org\'s settings, canEdit only with org:settings, never cached', async () => {
    const res = await call(router, 'get', '/security-notifications');
    expect(svc.getSecurityPrefs).toHaveBeenCalledWith('org-a', false);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ preferences: { recipientMode: 'writers', canEdit: false } });
    expect(res.headers['Cache-Control']).toBe('no-store');

    await call(router, 'get', '/security-notifications', { user: { sub: 'u-1', organizationId: 'org-a', permissions: ['plugins:read', 'org:settings'] } });
    expect(svc.getSecurityPrefs).toHaveBeenLastCalledWith('org-a', true);
  });

  it('PUT hands org, user, body and the request headers to the service', async () => {
    const res = await call(router, 'put', '/security-notifications', { body: { recipientMode: 'users', targetUsers: ['u2'] } });
    // The headers are the 4th argument for ONE reason: the Ask provenance
    // marker, which the service folds into its audit event (design rule 6).
    expect(svc.putSecurityPrefs).toHaveBeenCalledWith('org-a', 'u-1', { recipientMode: 'users', targetUsers: ['u2'] }, {});
    expect(res.body.data).toEqual({ preferences: { recipientMode: 'users' } });
  });

  it('PUT is gated by `proposable`, ahead of the handler', () => {
    const layer = (router as unknown as { stack: Layer[] }).stack
      .find((l) => l.route?.path === '/security-notifications' && l.route.methods.put);
    const names = layer!.route!.stack.map((sl) => sl.handle.name);
    expect(names).toContain('proposable');
    expect(names.indexOf('proposable')).toBeLessThan(names.length - 1);
  });

  it('PUT answers a validation refusal as a 400 with its code', async () => {
    svc.putSecurityPrefs.mockRejectedValueOnce(new EcosystemError('VALIDATION_ERROR' as any, 'webhookUrl must be an https URL'));
    const res = await call(router, 'put', '/security-notifications', { body: { webhookUrl: 'http://x' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'webhookUrl must be an https URL' });
  });

  it('POST /test sends on every channel and reports each', async () => {
    const res = await call(router, 'post', '/security-notifications/test');
    expect(svc.sendTestNotice).toHaveBeenCalledWith('org-a', 'u-1');
    expect(res.body.data).toEqual({ result: { relay: 'sent', webhook: null, externalEmail: 'none' } });
  });
});

describe('anonymous confirmation', () => {
  const router = createPublicSecurityNotificationRoutes();

  it('consumes the body token; no caller identity needed', async () => {
    const res = await call(router, 'post', '/confirm', { body: { token: 'tok' }, user: undefined });
    expect(svc.confirmExternalEmail).toHaveBeenCalledWith('tok');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ data: { confirmed: true }, message: 'Address confirmed' });
  });
});

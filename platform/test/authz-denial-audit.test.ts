// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's OWN `requireSystemAdmin` gates feed the shared `authz.denied` sink.
 *
 * Platform keeps two copies (a route middleware in `middleware/auth.ts` and a
 * controller-body guard in `helpers/controller-helper.ts`) rather than using
 * api-core's, because only platform's answers 401 to an UNAUTHENTICATED caller.
 * That divergence is what let both drift away from api-core's gate, which
 * records every refusal — so a refused sysadmin WRITE on the one service where
 * the trail matters most (impersonation, user admin, SSO/SCIM config) left no
 * audit event at all. These pin the wiring in both copies.
 *
 * The recorder itself is api-core's REAL `recordAuthzDenial` (the mock spreads
 * the real module), so the GET/HEAD/OPTIONS skip is exercised too.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Loading the auth middleware pulls in platform's config module, which refuses
// to boot without these secrets.
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: jest.fn<AnyFn>(),
  isSystemAdmin: (req: any) => req?.user?.isSuperAdmin === true,
  isSystemOrgId: () => false,
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  ImpersonationRequest: {},
  PersonalAccessToken: {},
  User: { findById: jest.fn() },
  Organization: { findById: jest.fn() },
  UserOrganization: { findOne: jest.fn() },
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  verifyAccessToken: jest.fn(),
  verifyRefreshToken: jest.fn(),
}));

const { setAuthzDenialAuditor } = await import('@pipeline-builder/api-core');
const { requireSystemAdmin: routeGate } = await import('../src/middleware/auth.js');
const { requireSystemAdmin: bodyGate } = await import('../src/helpers/controller-helper.js');

const denials: Array<Record<string, unknown>> = [];
setAuthzDenialAuditor((info) => { denials.push(info as unknown as Record<string, unknown>); });
afterAll(() => setAuthzDenialAuditor(undefined));

const res = () => ({ status: jest.fn(), json: jest.fn() }) as any;
const req = (over: Record<string, unknown> = {}) => ({
  method: 'POST',
  originalUrl: '/admin/impersonate/u1?token=secret',
  url: '/admin/impersonate/u1',
  headers: {},
  user: { sub: 'u1', email: 'u1@example.com', organizationId: 'org-1', isSuperAdmin: false },
  ...over,
}) as any;

beforeEach(() => { denials.length = 0; });

describe('requireSystemAdmin (route middleware)', () => {
  it('records the denial when an authenticated non-sysadmin attempts a write', () => {
    routeGate(req(), res(), jest.fn());
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      actorId: 'u1',
      actorEmail: 'u1@example.com',
      orgId: 'org-1',
      method: 'POST',
      required: 'system-admin',
    });
    // The query string is stripped before the path is persisted.
    expect(denials[0].path).toBe('/admin/impersonate/u1');
  });

  it('records nothing for a refused READ (scan noise) or for a sysadmin', () => {
    routeGate(req({ method: 'GET' }), res(), jest.fn());
    const next = jest.fn();
    routeGate(req({ user: { sub: 'sa', isSuperAdmin: true } }), res(), next);
    expect(next).toHaveBeenCalled();
    expect(denials).toHaveLength(0);
  });

  it('records nothing for an UNAUTHENTICATED caller — that is a 401, not a refusal', () => {
    routeGate(req({ user: undefined }), res(), jest.fn());
    expect(denials).toHaveLength(0);
  });
});

describe('requireSystemAdmin (controller-body guard)', () => {
  it('records the denial when an authenticated non-sysadmin attempts a write', () => {
    expect(bodyGate(req(), res())).toBe(false);
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ actorId: 'u1', method: 'POST', required: 'system-admin' });
  });

  it('admits a sysadmin and records nothing', () => {
    expect(bodyGate(req({ user: { sub: 'sa', isSuperAdmin: true } }), res())).toBe(true);
    expect(denials).toHaveLength(0);
  });
});

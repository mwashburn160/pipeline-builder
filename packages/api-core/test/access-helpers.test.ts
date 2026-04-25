// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { applyAccessControl, requirePublicAccess } from '../src/helpers/access-helpers';

function createMockReq(user?: Partial<Request['user']>): Request {
  return { user: user as Request['user'] } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

const NON_ADMIN = createMockReq({ role: 'member', organizationId: 'org-1', organizationName: 'acme' });
const ADMIN = createMockReq({ role: 'admin', organizationId: 'system', organizationName: 'system' });

describe('applyAccessControl', () => {
  // Regression: previously forced accessModifier='private' for non-admins,
  // which made list queries exclude all system-public catalog rows.
  it('does not inject accessModifier for non-admins', () => {
    const filter: { name: string; accessModifier?: string } = { name: 'foo' };
    const out = applyAccessControl(filter, NON_ADMIN);
    expect(out).toEqual({ name: 'foo' });
    expect(out.accessModifier).toBeUndefined();
  });

  it('does not inject accessModifier for admins', () => {
    const filter: { name: string; accessModifier?: string } = { name: 'foo' };
    const out = applyAccessControl(filter, ADMIN);
    expect(out).toEqual({ name: 'foo' });
    expect(out.accessModifier).toBeUndefined();
  });

  it('preserves a caller-supplied accessModifier', () => {
    const filter = { accessModifier: 'public', name: 'foo' };
    const out = applyAccessControl(filter, NON_ADMIN);
    expect(out.accessModifier).toBe('public');
    expect(out.name).toBe('foo');
  });

  it('returns the same filter shape for admin and non-admin', () => {
    const filter: { name: string; isActive: boolean; accessModifier?: string } = {
      name: 'plugin',
      isActive: true,
    };
    expect(applyAccessControl(filter, NON_ADMIN)).toEqual(filter);
    expect(applyAccessControl(filter, ADMIN)).toEqual(filter);
  });

  it('returns empty filter unchanged', () => {
    const empty: { accessModifier?: string } = {};
    expect(applyAccessControl(empty, NON_ADMIN)).toEqual({});
    expect(applyAccessControl(empty, ADMIN)).toEqual({});
  });
});

describe('requirePublicAccess', () => {
  it('allows admins to modify a public resource', () => {
    const res = createMockRes();
    const ok = requirePublicAccess(ADMIN, res, { accessModifier: 'public' });
    expect(ok).toBe(true);
    expect(res._status).toBe(0);
  });

  it('allows admins to modify a private resource', () => {
    const res = createMockRes();
    const ok = requirePublicAccess(ADMIN, res, { accessModifier: 'private' });
    expect(ok).toBe(true);
    expect(res._status).toBe(0);
  });

  it('allows non-admins to modify private resources', () => {
    const res = createMockRes();
    const ok = requirePublicAccess(NON_ADMIN, res, { accessModifier: 'private' });
    expect(ok).toBe(true);
    expect(res._status).toBe(0);
  });

  it('blocks non-admins from modifying public resources with 403', () => {
    const res = createMockRes();
    const ok = requirePublicAccess(NON_ADMIN, res, { accessModifier: 'public' });
    expect(ok).toBe(false);
    expect(res._status).toBe(403);
  });

  it('blocks non-admins when accessModifier is missing (treated as non-private)', () => {
    const res = createMockRes();
    const ok = requirePublicAccess(NON_ADMIN, res, {});
    expect(ok).toBe(false);
    expect(res._status).toBe(403);
  });
});

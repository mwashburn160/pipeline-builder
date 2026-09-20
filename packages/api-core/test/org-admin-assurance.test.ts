// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireOrgAdminAssurance` — the org policy "administrative actions require
 * MFA", enforced from the `org_admin_aal` claim so a service that can't read the
 * org document still honours it.
 *
 * Asserted on the refusal CODE, because the client branches on it: a weak
 * session gets 401 `MFA_REQUIRED` (enrol / sign in with a factor), a machine on a
 * human-only route gets 403 `HUMAN_SESSION_REQUIRED` (stop).
 */

import { jest, describe, it, expect } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import {
  ORG_ADMIN_MFA_REASON,
  orgAdminAssuranceRefusal,
  requireOrgAdminAssurance,
} from '../src/middleware/auth.js';
import { buildRouteTable, getRouteGates } from '../src/middleware/route-table.js';

function mockReq(user: Record<string, unknown> | undefined): Request {
  return { headers: {}, method: 'POST', url: '/x', originalUrl: '/x', user } as unknown as Request;
}

function mockRes(): Response & { _status: number; _json: { code?: string; details?: { reason?: string } } | null } {
  const res = {
    _status: 0,
    _json: null as { code?: string } | null,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body as { code?: string }; return res; },
  };
  return res as unknown as Response & { _status: number; _json: { code?: string; details?: { reason?: string } } | null };
}

const run = (user: Record<string, unknown> | undefined, machines: 'allow' | 'refuse') => {
  const req = mockReq(user);
  const res = mockRes();
  const next = jest.fn();
  requireOrgAdminAssurance({ machines })(req, res, next);
  return { res, next };
};

const human = { principalType: 'user', token_use: 'access', sub: 'u1', auth_time: Math.floor(Date.now() / 1000) };
const pat = { principalType: 'user', token_use: 'api_key', sub: 'u1', jti: 'k1', aal: 1 };
const serviceAccount = { principalType: 'service_account', token_use: 'api_key', sub: 'sa1', jti: 'k2', aal: 1 };

describe('requireOrgAdminAssurance', () => {
  it('is a no-op while the org policy is off (no claim), even for a single-factor session', () => {
    const { next, res } = run({ ...human, aal: 1 }, 'allow');
    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });

  it('admits an MFA-grade session when the policy is on', () => {
    const { next } = run({ ...human, aal: 2, org_admin_aal: 2 }, 'refuse');
    expect(next).toHaveBeenCalled();
  });

  it('refuses a single-factor session with 401 MFA_REQUIRED naming the org policy', () => {
    const { next, res } = run({ ...human, aal: 1, org_admin_aal: 2 }, 'allow');
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json?.code).toBe('MFA_REQUIRED');
    expect(res._json?.details?.reason).toBe(ORG_ADMIN_MFA_REASON);
  });

  it('treats a missing aal as single-factor (fail closed)', () => {
    const { res } = run({ ...human, org_admin_aal: 2 }, 'allow');
    expect(res._json?.code).toBe('MFA_REQUIRED');
  });

  it('lets a PAT or a service account through on a machine-callable route', () => {
    expect(run({ ...pat, org_admin_aal: 2 }, 'allow').next).toHaveBeenCalled();
    expect(run({ ...serviceAccount, org_admin_aal: 2 }, 'allow').next).toHaveBeenCalled();
  });

  it('refuses a machine credential with 403 HUMAN_SESSION_REQUIRED on a human-only route', () => {
    const { res, next } = run({ ...pat, org_admin_aal: 2 }, 'refuse');
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._json?.code).toBe('HUMAN_SESSION_REQUIRED');
  });

  it('does not refuse a machine on a human-only route while the policy is off', () => {
    expect(run(pat, 'refuse').next).toHaveBeenCalled();
  });

  it('401s when nothing authenticated first', () => {
    expect(run(undefined, 'allow').res._status).toBe(401);
  });

  it('exposes the same decision for handler-level use', () => {
    expect(orgAdminAssuranceRefusal(undefined, { machines: 'allow' })).toBeUndefined();
    expect(orgAdminAssuranceRefusal({ ...human, aal: 1, org_admin_aal: 2 } as never, { machines: 'allow' })?.code).toBe('MFA_REQUIRED');
    expect(orgAdminAssuranceRefusal({ ...pat, org_admin_aal: 2 } as never, { machines: 'refuse' })?.code).toBe('HUMAN_SESSION_REQUIRED');
  });
});

describe('route table', () => {
  it('tags the gate with its machine decision', () => {
    expect(getRouteGates(requireOrgAdminAssurance({ machines: 'refuse' }))).toEqual([{ kind: 'orgAdminAssurance', machines: 'refuse' }]);
  });

  it('records the gate (strictest machine decision wins) and omits it elsewhere', () => {
    const app = express();
    const router = express.Router();
    router.post('/gated', requireOrgAdminAssurance({ machines: 'allow' }), requireOrgAdminAssurance({ machines: 'refuse' }), (_req, res) => res.end());
    router.post('/open', requireOrgAdminAssurance({ machines: 'allow' }), (_req, res) => res.end());
    router.post('/plain', (_req, res) => res.end());
    app.use('/x', router);
    const table = buildRouteTable(app);
    expect(table.find((e) => e.path === '/x/gated')?.orgAdminAssurance).toEqual({ machines: 'refuse' });
    expect(table.find((e) => e.path === '/x/open')?.orgAdminAssurance).toEqual({ machines: 'allow' });
    // Absent, not false — tables of services without the gate stay unchanged.
    expect('orgAdminAssurance' in (table.find((e) => e.path === '/x/plain') ?? {})).toBe(false);
  });
});

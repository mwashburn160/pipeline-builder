// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth({ minAssurance })`, `requireAssurance`, the bootstrap-session
 * refusal and the factor-restricted step-up (#8).
 *
 * These are the gates a route relies on to mean "a PERSON, with a second
 * factor, recently" — so every refusal is asserted on its CODE, not just on the
 * status: the client branches on `MFA_REQUIRED` (enrol), `REAUTH_REQUIRED`
 * (sign in again) and `HUMAN_SESSION_REQUIRED` (stop, you are a machine) in
 * three different ways.
 */

import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import {
  isHumanPrincipal, requireAssurance, requireAuth, signServiceToken,
} from '../src/middleware/auth.js';
import {
  buildRouteTable, getRouteGates,
} from '../src/middleware/route-table.js';
import { requireStepUp, STRONG_STEP_UP_METHODS } from '../src/middleware/step-up.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import {
  installTestJwks, signTestUserToken, testUserIdentityClaims, uninstallTestJwks,
  type TestJwksHandle,
} from '../src/testing/user-tokens.js';

let jwks: TestJwksHandle;
let serviceKeys: TestServiceKeysHandle;
beforeAll(() => { serviceKeys = installTestServiceKeys(['billing']); });
beforeEach(() => { jwks = installTestJwks(); });
afterAll(() => { uninstallTestJwks(); serviceKeys.uninstall(); });

/** Let the async verification chain settle before asserting. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, method: 'POST', url: '/x', originalUrl: '/x', user: undefined, ...overrides } as unknown as Request;
}

function mockRes(): Response & { _status: number; _json: { code?: string; message?: string } | null } {
  const res = {
    _status: 0,
    _json: null as { code?: string } | null,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body as { code?: string }; return res; },
  };
  return res as unknown as Response & { _status: number; _json: { code?: string; message?: string } | null };
}

function userToken(payload: Record<string, unknown> = {}): Promise<string> {
  return signTestUserToken(
    { ...testUserIdentityClaims(), sub: 'user1', role: 'member', ...payload },
    { key: jwks.primary },
  );
}

/** Run `requireAuth(options)` against a bearer token and return the response. */
async function run(options: Parameters<typeof requireAuth>[0], token: string) {
  const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
  const res = mockRes();
  const next = jest.fn();
  (requireAuth(options) as (r: Request, s: Response, n: () => void) => void)(req, res, next);
  await settle();
  await settle();
  return { req, res, next };
}

describe('requireAuth({ minAssurance })', () => {
  it('admits an aal-2 session', async () => {
    const { res, next } = await run({ minAssurance: 2 }, await userToken({ aal: 2, amr: ['webauthn'] }));
    expect(next).toHaveBeenCalled();
    expect(res._status).toBe(0);
  });

  it('refuses an aal-1 session with 401 MFA_REQUIRED', async () => {
    const { res, next } = await run({ minAssurance: 2 }, await userToken({ aal: 1 }));
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect(res._json?.code).toBe('MFA_REQUIRED');
  });

  it('leaves an ungated route alone at aal 1', async () => {
    const { next } = await run({}, await userToken({ aal: 1 }));
    expect(next).toHaveBeenCalled();
  });

  describe('maxAge', () => {
    it('admits a recent MFA-grade sign-in', async () => {
      const token = await userToken({ aal: 2, auth_time: Math.floor(Date.now() / 1000) - 30 });
      const { next } = await run({ minAssurance: 2, maxAge: 300 }, token);
      expect(next).toHaveBeenCalled();
    });

    it('refuses a stale one with 401 REAUTH_REQUIRED, not MFA_REQUIRED', async () => {
      const token = await userToken({ aal: 2, auth_time: Math.floor(Date.now() / 1000) - 3600 });
      const { res, next } = await run({ minAssurance: 2, maxAge: 300 }, token);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      // The distinction is what tells the client to re-authenticate rather than
      // send the person off to enrol a factor they already have.
      expect(res._json?.code).toBe('REAUTH_REQUIRED');
    });

    it('is ignored without minAssurance — "how recent" is only asked once "how strong" is', async () => {
      const token = await userToken({ aal: 1, auth_time: Math.floor(Date.now() / 1000) - 3600 });
      const { next } = await run({ maxAge: 1 }, token);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('machine principals never satisfy it', () => {
    it('refuses an exchanged access key (token_use: api_key) even at aal 2', async () => {
      const token = await userToken({ aal: 2, token_use: 'api_key', jti: 'key1' });
      const { res, next } = await run({ minAssurance: 2 }, token);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._json?.code).toBe('HUMAN_SESSION_REQUIRED');
    });

    it('refuses an org service account', async () => {
      const token = await userToken({ aal: 2, principalType: 'service_account', token_use: 'api_key', jti: 'key1' });
      const { res } = await run({ minAssurance: 2 }, token);
      expect(res._status).toBe(403);
      expect(res._json?.code).toBe('HUMAN_SESSION_REQUIRED');
    });

    it('refuses an internal service principal — an MFA route is a human route', async () => {
      serviceKeys.becomeService('billing');
      const token = signServiceToken({ serviceName: 'billing', role: 'member' });
      const { res, next } = await run({ minAssurance: 2 }, token);
      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
      expect(res._json?.code).toBe('HUMAN_SESSION_REQUIRED');
    });
  });

  it('classifies principals with isHumanPrincipal', () => {
    expect(isHumanPrincipal({ principalType: 'user', token_use: 'access' })).toBe(true);
    expect(isHumanPrincipal({ principalType: 'user', token_use: 'api_key' })).toBe(false);
    expect(isHumanPrincipal({ principalType: 'service_account', token_use: 'api_key' })).toBe(false);
    expect(isHumanPrincipal({ principalType: 'service', token_use: 'access' })).toBe(false);
    expect(isHumanPrincipal(undefined)).toBe(false);
  });
});

describe('bootstrap enrolment sessions outside platform', () => {
  it('are refused outright with 403 MFA_ENROLLMENT_REQUIRED', async () => {
    const token = await userToken({ aal: 1, mfaEnrollmentPending: true });
    const { res, next } = await run({}, token);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._json?.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('are refused even on a route with no assurance requirement at all', async () => {
    const token = await userToken({ aal: 1, mfaEnrollmentPending: true });
    const { res } = await run({ allowOrgHeaderOverride: true }, token);
    expect(res._status).toBe(403);
  });
});

describe('requireAssurance (standalone, for a service with its own requireAuth)', () => {
  const runGate = (user: Record<string, unknown> | undefined, opts: Parameters<typeof requireAssurance>[0]) => {
    const req = mockReq({ user: user as Request['user'] });
    const res = mockRes();
    const next = jest.fn();
    requireAssurance(opts)(req, res, next);
    return { res, next };
  };

  const human = { principalType: 'user', token_use: 'access', sub: 'u1', auth_time: Math.floor(Date.now() / 1000) };

  it('admits an MFA-grade session', () => {
    const { next } = runGate({ ...human, aal: 2 }, { minAssurance: 2 });
    expect(next).toHaveBeenCalled();
  });

  it('refuses a weak one identically to the inline option', () => {
    const { res } = runGate({ ...human, aal: 1 }, { minAssurance: 2 });
    expect(res._status).toBe(401);
    expect(res._json?.code).toBe('MFA_REQUIRED');
  });

  it('401s when nothing authenticated first', () => {
    const { res } = runGate(undefined, { minAssurance: 2 });
    expect(res._status).toBe(401);
  });

  it('fails closed when auth_time is missing and maxAge is asked for', () => {
    const { res } = runGate({ principalType: 'user', token_use: 'access', sub: 'u1', aal: 2 }, { minAssurance: 2, maxAge: 60 });
    expect(res._json?.code).toBe('REAUTH_REQUIRED');
  });

  // A named exemption exists for exactly one case — the bootstrap-administrator
  // window, whose session CANNOT be MFA-grade because the install has no factor
  // to enrol with yet (platform's `isBootstrapSetupRequest`). What matters here is
  // that the carve-out is narrow and visible: it fires only when the predicate
  // says so, it still needs an authenticated request, and the route keeps its
  // `minAssurance` tag plus the exemption's name.
  describe('a named exemption', () => {
    const weak = { ...human, aal: 1 };

    it('admits the request the predicate names', () => {
      const { next, res } = runGate(weak, { minAssurance: 2, exempt: { reason: 'bootstrap-setup', when: () => true } });
      expect(next).toHaveBeenCalled();
      expect(res._json).toBeNull(); // nothing was sent — the gate passed it on
    });

    it('refuses every other request on the same route', () => {
      const { res } = runGate(weak, { minAssurance: 2, exempt: { reason: 'bootstrap-setup', when: () => false } });
      expect(res._status).toBe(401);
      expect(res._json?.code).toBe('MFA_REQUIRED');
    });

    it('never admits an unauthenticated caller, whatever the predicate says', () => {
      const { res, next } = runGate(undefined, { minAssurance: 2, exempt: { reason: 'bootstrap-setup', when: () => true } });
      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('keeps the level on the route table and names the carve-out there', () => {
      const gate = requireAssurance({ minAssurance: 2, exempt: { reason: 'bootstrap-setup', when: () => false } });
      expect(getRouteGates(gate)).toEqual([{ kind: 'assurance', minAssurance: 2, exempt: 'bootstrap-setup' }]);
    });
  });
});

describe('requireStepUp({ methods })', () => {
  it('tags the route table with the factors it accepts', () => {
    const gate = requireStepUp({ methods: STRONG_STEP_UP_METHODS });
    expect(getRouteGates(gate)).toEqual([{ kind: 'stepUp', methods: ['webauthn', 'totp'] }]);
  });

  it('leaves the plain form unrestricted', () => {
    expect(getRouteGates(requireStepUp)).toEqual([{ kind: 'stepUp' }]);
  });
});

describe('route table', () => {
  it('records the strictest assurance and the tightest maxAge across a chain', () => {
    // Two gates both run, so the table must report what a caller actually has to
    // satisfy — not whichever one was declared last.
    const app = express();
    const router = express.Router();
    router.post('/x',
      requireAuth({ minAssurance: 1, maxAge: 600 }),
      requireAssurance({ minAssurance: 2, maxAge: 120 }),
      requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
      (_req, res) => res.end());
    app.use('/admin', router);

    const entry = buildRouteTable(app).find((e) => e.path === '/admin/x' && e.method === 'POST');
    expect(entry?.minAssurance).toBe(2);
    expect(entry?.maxAge).toBe(120);
    expect(entry?.stepUp).toBe(true);
    expect(entry?.stepUpMethods).toEqual(['totp', 'webauthn']);
  });

  it('reports no assurance requirement for an ordinary route', () => {
    const app = express();
    app.get('/open', requireAuth, (_req, res) => res.end());
    const entry = buildRouteTable(app).find((e) => e.path === '/open');
    expect(entry?.minAssurance).toBe(0);
    expect(entry?.maxAge).toBeUndefined();
    expect(entry?.stepUpMethods).toEqual([]);
  });
});

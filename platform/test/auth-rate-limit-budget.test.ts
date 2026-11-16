// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What an ordinary sign-in costs against the `/auth*` rate-limit buckets.
 *
 * "Too many authentication attempts" on a sign-in page nobody had submitted was
 * fixed five times, one route at a time — sign-out, the Security page's reads,
 * refresh/switch-org, the passkey challenge — because the strict per-IP bucket
 * sat on the whole `/auth` tree and every new route joined it by default (and
 * `/auth/oauth/*` and `/auth/sso/*` were counted twice). The buckets are now
 * attached route by route (middleware/auth-limiters.ts). This suite pins the
 * POLICY, so the next route that would spend the sign-in budget by accident
 * fails here instead of on someone's phone:
 *
 *  1. the routes a person hits without guessing anything — loading the sign-in
 *     page, keeping a session alive, the Security page, signing out — spend no
 *     per-IP sign-in or sign-up budget at all;
 *  2. exactly the listed credential-presenting routes spend the sign-in bucket,
 *     and that bucket counts FAILURES only, so a correct sign-in spends nothing;
 *  3. the factor enrolment an enrolment-only (bootstrap admin) session must
 *     reach is on the per-USER bucket, never a per-IP one it could be locked
 *     out of by failed sign-ins from the same address;
 *  4. no request is counted twice against one bucket.
 *
 * Then the limiters themselves, through real HTTP: failures fill the bucket,
 * successes don't, and the 429 says how long to wait.
 */

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import { middlewareChains } from './helpers/limiter-chains.js';

process.env.JWT_SECRET ||= 'auth-rate-limit-budget-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
// Each limiter falls back to its in-process memory store without Redis.
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

const { mountApiRoutes } = await import('../src/routes/mount.js');
const limiters = await import('../src/middleware/auth-limiters.js');
const { loginAccountLimiter } = await import('../src/middleware/login-limiter.js');
const { config } = await import('../src/config/index.js');

/** Every bucket this suite reasons about, by the name a failure message uses. */
const BUCKETS = new Map<unknown, string>([
  [limiters.signInLimiter, 'signIn'],
  [limiters.registerLimiter, 'register'],
  [limiters.authDiscoveryLimiter, 'discovery'],
  [limiters.accountSecurityLimiter, 'accountSecurity'],
  [loginAccountLimiter, 'loginAccount'],
]);

/** The per-IP buckets a person can be locked out of from a shared address. */
const PER_IP_SIGN_IN_BUCKETS = ['signIn', 'register'];

let chains: Map<string, unknown[]>;

/** The buckets `route` spends, in chain order (duplicates kept, so a double count shows). */
function bucketsOf(route: string): string[] {
  const chain = chains.get(route);
  if (!chain) throw new Error(`No such route in the table: ${route}`);
  return chain.map((fn) => BUCKETS.get(fn)).filter((b): b is string => b !== undefined);
}

beforeAll(() => {
  const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();
  const app = express();
  mountApiRoutes(app, { alertWebhook: passthrough, observability: passthrough, scim: passthrough });
  chains = middlewareChains(app);
});

describe('which /auth routes spend which bucket', () => {
  /** What the sign-in page asks for on its own, before anyone submits anything. */
  const SIGN_IN_PAGE = [
    'GET /auth/oauth/providers',
    'POST /auth/webauthn/login/options',
    'POST /auth/sso/discover',
  ];
  /** Starting an OAuth/SSO redirect: builds a URL, presents nothing. */
  const FLOW_STARTS = [
    'GET /auth/oauth/:provider/url',
    'POST /auth/sso/start',
    'GET /auth/sso/:orgId/authorize',
  ];
  /** A signed-in person keeping their session, reading their own factors, leaving. */
  const SIGNED_IN = [
    'POST /auth/refresh',
    'POST /auth/switch-org',
    'GET /auth/webauthn/credentials',
    'GET /auth/totp/status',
    'GET /auth/recovery-codes',
    'POST /auth/logout',
    'POST /auth/sso/logout',
  ];
  /** Exactly the routes that present a credential or single-use secret. */
  const CREDENTIAL = [
    'POST /auth/key/revoke',
    'POST /auth/key/rotate',
    'POST /auth/login',
    'POST /auth/mfa/verify',
    'POST /auth/oauth/:provider/callback',
    'POST /auth/password/change-required',
    'POST /auth/password/reset',
    'POST /auth/sso/:orgId/callback',
    'POST /auth/sso/:orgId/saml/acs',
    'POST /auth/sso/:orgId/saml/complete',
    'POST /auth/step-up',
    'POST /auth/step-up/reauth/callback',
    'POST /auth/step-up/totp',
    'POST /auth/step-up/webauthn/verify',
    'POST /auth/token/exchange',
    'POST /auth/verify-email',
    'POST /auth/webauthn/login/verify',
  ];
  /** What an enrolment-only session (bootstrap admin) must reach to get out of it. */
  const ENROLMENT = [
    'POST /auth/webauthn/register/options',
    'POST /auth/webauthn/register/verify',
    'POST /auth/totp/enrol',
    'POST /auth/totp/activate',
  ];

  it.each(SIGN_IN_PAGE)('%s — a sign-in page load spends only the discovery bucket', (route) => {
    expect(bucketsOf(route)).toEqual(['discovery']);
  });

  it.each(FLOW_STARTS)('%s — starting a redirect spends only the discovery bucket', (route) => {
    expect(bucketsOf(route)).toEqual(['discovery']);
  });

  it.each(SIGNED_IN)('%s — keeping or leaving a session spends no /auth bucket', (route) => {
    expect(bucketsOf(route)).toEqual([]);
  });

  it.each(ENROLMENT)('%s — enrolment is bounded per user, never per IP', (route) => {
    expect(bucketsOf(route)).toEqual(['accountSecurity']);
  });

  it('puts exactly the credential-presenting routes on the sign-in bucket', () => {
    // An exact set, not "includes": a route added to the bucket must be added
    // here too, which is the moment to ask whether it really presents a credential.
    const onSignIn = [...chains.keys()].filter((r) => bucketsOf(r).includes('signIn')).sort();
    expect(onSignIn).toEqual([...CREDENTIAL].sort());
  });

  it('bounds account creation per IP, counting successes', () => {
    expect(bucketsOf('POST /auth/register')).toEqual(['register']);
  });

  it('bounds failed password sign-ins per IP AND per account', () => {
    expect(bucketsOf('POST /auth/login')).toEqual(['signIn', 'loginAccount']);
  });

  it('counts no request twice against one bucket', () => {
    const doubled = [...chains.keys()].filter((r) => {
      const b = bucketsOf(r);
      return new Set(b).size !== b.length;
    });
    expect(doubled).toEqual([]);
  });

  it('keeps the per-IP sign-in buckets off everything a non-guessing visit makes', () => {
    for (const route of [...SIGN_IN_PAGE, ...FLOW_STARTS, ...SIGNED_IN, ...ENROLMENT]) {
      expect([route, bucketsOf(route).filter((b) => PER_IP_SIGN_IN_BUCKETS.includes(b))]).toEqual([route, []]);
    }
  });
});

describe('the sign-in bucket at runtime', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    // `extractClientIp` reads `req.ip`; trust the test's X-Forwarded-For so each
    // test spends its own address's bucket.
    app.set('trust proxy', true);
    app.post('/fail', limiters.signInLimiter, (_req, res) => { res.status(401).json({ success: false }); });
    app.post('/ok', limiters.signInLimiter, (_req, res) => { res.status(200).json({ success: true }); });
    app.get('/discover', limiters.authDiscoveryLimiter, (_req, res) => { res.status(200).json({ success: true }); });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = (method: string, path: string, ip: string) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'x-forwarded-for': ip } });

  it('never fills on correct sign-ins', async () => {
    const max = config.rateLimit.auth.max;
    for (let i = 0; i < max * 2; i += 1) {
      expect((await call('POST', '/ok', '198.51.100.1')).status).toBe(200);
    }
  });

  it('fills on failures, then answers 429 saying how long to wait', async () => {
    const max = config.rateLimit.auth.max;
    for (let i = 0; i < max; i += 1) {
      expect((await call('POST', '/fail', '198.51.100.2')).status).toBe(401);
    }
    const refused = await call('POST', '/fail', '198.51.100.2');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await refused.json() as { code?: string; message?: string; details?: { retryAfterSeconds?: number } };
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.message).toBe('Too many authentication attempts. Please try again later.');
    expect(body.details?.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.details?.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(config.rateLimit.auth.windowMs / 1000));
    // A full bucket refuses the correct password too — it is per address.
    expect((await call('POST', '/ok', '198.51.100.2')).status).toBe(429);
  });

  it('lets an office NAT load the sign-in page many times', async () => {
    // Twenty people behind one address each loading the page — well past the
    // old 20-per-15-minute budget a single page load used to spend twice.
    for (let i = 0; i < 40; i += 1) {
      expect((await call('GET', '/discover', '198.51.100.3')).status).toBe(200);
    }
  });
});

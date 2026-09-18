// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Device authorization grant (RFC 8628) — `controllers/device-auth.ts` driving
 * the real `services/device-auth-service.ts` state machine.
 *
 * The service is NOT mocked: the whole point of these tests is the state
 * machine (pending → slow_down → approved/denied → single-use consume →
 * expiry), and mocking it would only assert that the controller forwards calls.
 * Only the edges are stubbed: token minting, audit, metrics and the user lookup.
 *
 * With no Redis configured the pending-state store runs on its process-local
 * fallback, which is the same code path Redis-less deployments use.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// The config module refuses to load without these (no NODE_ENV=production here,
// so the dev fallbacks apply to everything else).
process.env.JWT_SECRET ||= 'device-auth-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
process.env.PLATFORM_FRONTEND_URL ||= 'https://platform.example.com';

const mockAudit = jest.fn();
const mockIncCounter = jest.fn();
const mockIssueTokens = jest.fn<(...a: unknown[]) => unknown>();
const mockIssueStepUp = jest.fn<(...a: unknown[]) => unknown>();
const mockFindForTokenIssue = jest.fn<(...a: unknown[]) => unknown>();

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  sendSuccess: (res: any, status: number, data?: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findForTokenIssue: (...a: unknown[]) => mockFindForTokenIssue(...a) },
}));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  issueStepUpToken: (...a: unknown[]) => mockIssueStepUp(...a),
  // Faithful stand-in for the real helper (whose own semantics — inherit, never
  // raise, fail closed — are covered in the token suites). Importing the real
  // module here would drag in mongoose models for no added coverage.
  authFromClaims: (claims: any) => {
    if (!claims || !Array.isArray(claims.amr) || (claims.aal !== 1 && claims.aal !== 2) || typeof claims.auth_time !== 'number') {
      throw new Error('SESSION_AUTH_MISSING');
    }
    return { amr: [...claims.amr], aal: claims.aal, authTime: new Date(claims.auth_time * 1000) };
  },
}));

const {
  startDeviceCode, deviceToken, getDeviceRequest, approveDeviceRequest, denyDeviceRequest,
} = await import('../src/controllers/device-auth.js');
const { _resetDeviceStoresForTests } = await import('../src/services/device-auth-service.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Last JSON body the handler wrote. */
function body(res: any) {
  return res.json.mock.calls.at(-1)?.[0];
}

function statusOf(res: any) {
  return res.status.mock.calls.at(-1)?.[0];
}

async function call(handler: unknown, req: Record<string, unknown>) {
  const full: any = { body: {}, query: {}, headers: { 'user-agent': 'pipeline-manager/3.4.0 (darwin)' }, ip: '203.0.113.7', ...req };
  const res = mockRes();
  await (handler as any)(full, res, jest.fn());
  return res;
}

/** A signed-in browser session approving a code. */
const APPROVER = {
  sub: 'user-1',
  organizationId: 'org-1',
  email: 'dev@example.com',
  amr: ['sso'],
  aal: 1,
  auth_time: 1_700_000_000,
};

async function start(extra: Record<string, unknown> = {}) {
  const res = await call(startDeviceCode, { body: extra });
  return body(res);
}

/** Move the whole module graph's clock forward (the store keys off Date.now). */
let clockOffset = 0;
const realNow = Date.now;

beforeEach(() => {
  jest.clearAllMocks();
  clockOffset = 0;
  _resetDeviceStoresForTests();
  mockIssueTokens.mockResolvedValue({ accessToken: 'access.jwt', refreshToken: 'refresh.jwt', expiresIn: 900 });
  mockIssueStepUp.mockReturnValue({ token: 'stepup.jwt', expiresAt: 1_700_000_060 });
  mockFindForTokenIssue.mockResolvedValue({ _id: 'user-1' });
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
});

afterEach(() => jest.restoreAllMocks());

describe('POST /auth/device/code', () => {
  it('returns the RFC 8628 fields with an unambiguous user code', async () => {
    const res = await call(startDeviceCode, {});
    const data = body(res);

    expect(data.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(data.device_code).toHaveLength(43); // 32 random bytes, base64url
    expect(data.verification_uri).toBe('https://platform.example.com/auth/device');
    expect(data.verification_uri_complete).toBe(
      `https://platform.example.com/auth/device?user_code=${encodeURIComponent(data.user_code)}`,
    );
    expect(data.interval).toBe(5);
    expect(data.expires_in).toBe(600);
  });

  it('audits the start against the requesting device, never the codes', async () => {
    await call(startDeviceCode, {});
    const [, action, options] = mockAudit.mock.calls[0] as any[];
    expect(action).toBe('device.authorize.start');
    expect(options.details.client).toBe('pipeline-manager CLI on macOS');
    // The row carries only the flow's correlation handle — neither the device
    // code nor the user code (both are live credentials for the flow's lifetime).
    expect(options.targetId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(options)).not.toMatch(/[BCDFGHJKLMNPQRSTVWXZ]{4}/);
  });

  it('never issues the same user code twice', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 25; i += 1) codes.add((await start()).user_code);
    expect(codes.size).toBe(25);
  });
});

describe('POST /auth/device/token — the polling state machine', () => {
  it('reports authorization_pending until the browser decides', async () => {
    const started = await start();
    const res = await call(deviceToken, { body: { device_code: started.device_code } });

    expect(statusOf(res)).toBe(400);
    expect(body(res).error).toBe('authorization_pending');
  });

  it('answers slow_down and widens the interval when polled too fast', async () => {
    const started = await start();
    await call(deviceToken, { body: { device_code: started.device_code } });
    const res = await call(deviceToken, { body: { device_code: started.device_code } });

    expect(body(res)).toMatchObject({ error: 'slow_down', interval: 10 });

    // The widened interval sticks: a poll at the ORIGINAL 5s cadence is still
    // too fast, and pushes it out again.
    clockOffset += 6_000;
    expect(body(await call(deviceToken, { body: { device_code: started.device_code } }))).toMatchObject({
      error: 'slow_down',
      interval: 15,
    });
  });

  it('accepts a poll that honors the interval', async () => {
    const started = await start();
    await call(deviceToken, { body: { device_code: started.device_code } });
    clockOffset += 5_000;
    const res = await call(deviceToken, { body: { device_code: started.device_code } });

    expect(body(res).error).toBe('authorization_pending');
  });

  it('reports an unknown device code as expired_token (no enumeration oracle)', async () => {
    const res = await call(deviceToken, { body: { device_code: 'not-a-real-code' } });
    expect(body(res).error).toBe('expired_token');
  });

  it('expires the flow once its lifetime has passed, and audits it once', async () => {
    const started = await start();
    clockOffset += 601_000;

    expect(body(await call(deviceToken, { body: { device_code: started.device_code } })).error).toBe('expired_token');
    expect(mockAudit.mock.calls.map((c) => c[1])).toContain('device.authorize.expire');
    // The record is gone, so the code can't be revived by a later approval.
    expect(body(await call(deviceToken, { body: { device_code: started.device_code } })).error).toBe('expired_token');
  });

  it('will not redeem an APPROVED code that lapsed before the device came back', async () => {
    const started = await start();
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });
    // Inside the grace window the record is still readable (so "expired" can be
    // said precisely) but the deadline is what decides — no session is minted.
    clockOffset += 601_000;

    expect(body(await call(deviceToken, { body: { device_code: started.device_code } })).error).toBe('expired_token');
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('stops answering once the poll ceiling is blown', async () => {
    const started = await start();
    for (let i = 0; i < 200; i += 1) {
      clockOffset += 5_000;
      await call(deviceToken, { body: { device_code: started.device_code } });
    }
    clockOffset += 5_000;
    expect(body(await call(deviceToken, { body: { device_code: started.device_code } })).error).toBe('expired_token');
  });

  it('hands back access_denied after a denial, then forgets the flow', async () => {
    const started = await start();
    await call(denyDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });

    expect(body(await call(deviceToken, { body: { device_code: started.device_code } })).error).toBe('access_denied');
    expect(body(await call(deviceToken, { body: { device_code: started.device_code } })).error).toBe('expired_token');
  });
});

describe('POST /auth/device/token — issuing the session', () => {
  it('opens an ordinary interactive session carrying the DEVICE details', async () => {
    const started = await start();
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });
    clockOffset += 5_000;
    const res = await call(deviceToken, { body: { device_code: started.device_code } });

    expect(body(res)).toMatchObject({ access_token: 'access.jwt', refresh_token: 'refresh.jwt', token_type: 'Bearer', expires_in: 900 });
    const [, orgId, session] = mockIssueTokens.mock.calls[0] as any[];
    expect(orgId).toBe('org-1');
    expect(session.kind).toBe('interactive');
    // The device's own user-agent/IP, not the approving browser's.
    expect(session.client).toEqual({ userAgent: 'pipeline-manager CLI on macOS', ip: '203.0.113.7' });
  });

  it('inherits the approver\'s assurance and sign-in time verbatim', async () => {
    const started = await start();
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });
    clockOffset += 5_000;
    await call(deviceToken, { body: { device_code: started.device_code } });

    const [, , session] = mockIssueTokens.mock.calls[0] as any[];
    expect(session.auth.amr).toEqual(['sso']);
    expect(session.auth.aal).toBe(1);
    expect(session.auth.authTime.getTime()).toBe(1_700_000_000 * 1000);
  });

  it('is single-use: a second poll of an approved code gets nothing', async () => {
    const started = await start();
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });
    clockOffset += 5_000;
    await call(deviceToken, { body: { device_code: started.device_code } });
    clockOffset += 5_000;

    const res = await call(deviceToken, { body: { device_code: started.device_code } });
    expect(body(res).error).toBe('expired_token');
    expect(mockIssueTokens).toHaveBeenCalledTimes(1);
  });

  it('returns a step-up token only when the device asked for one', async () => {
    const plain = await start();
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: plain.user_code } });
    clockOffset += 5_000;
    expect(body(await call(deviceToken, { body: { device_code: plain.device_code } })).step_up_token).toBeUndefined();

    const elevated = await start({ step_up: true });
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: elevated.user_code } });
    clockOffset += 5_000;
    expect(body(await call(deviceToken, { body: { device_code: elevated.device_code } })).step_up_token).toBe('stepup.jwt');
  });

  it('withholds the step-up token when the approval\'s proof has gone stale', async () => {
    const started = await start({ step_up: true });
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });
    clockOffset += 301_000; // past the approval grace, still inside the code TTL

    const res = await call(deviceToken, { body: { device_code: started.device_code } });
    expect(body(res).access_token).toBe('access.jwt');
    expect(body(res).step_up_token).toBeUndefined();
  });

  it('refuses when the approving account no longer exists', async () => {
    mockFindForTokenIssue.mockResolvedValue(null);
    const started = await start();
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });
    clockOffset += 5_000;

    const res = await call(deviceToken, { body: { device_code: started.device_code } });
    expect(body(res).error).toBe('access_denied');
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });
});

describe('the browser approval endpoints', () => {
  it('shows what is being approved, without the device code', async () => {
    const started = await start();
    const res = await call(getDeviceRequest, { user: APPROVER, query: { user_code: started.user_code } });

    expect(body(res).data.request).toMatchObject({
      userCode: started.user_code,
      client: 'pipeline-manager CLI on macOS',
      ip: '203.0.113.7',
      stepUpRequested: false,
    });
    expect(JSON.stringify(body(res))).not.toContain(started.device_code);
  });

  it('accepts a user code however the person typed it', async () => {
    const started = await start();
    const typed = started.user_code.toLowerCase().replace('-', ' ');
    const res = await call(getDeviceRequest, { user: APPROVER, query: { user_code: typed } });

    expect(statusOf(res)).toBe(200);
  });

  it('404s an unrecognised code and 410s a lapsed one', async () => {
    expect(statusOf(await call(getDeviceRequest, { user: APPROVER, query: { user_code: 'BCDF-GHJK' } }))).toBe(404);

    // Inside the index's grace window a lapsed code is still recognised AS
    // lapsed, so the person is told to start again rather than to re-type.
    const started = await start();
    clockOffset += 601_000;
    expect(statusOf(await call(getDeviceRequest, { user: APPROVER, query: { user_code: started.user_code } }))).toBe(410);
  });

  it('refuses to decide the same code twice', async () => {
    const started = await start();
    expect(statusOf(await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } }))).toBe(200);
    expect(statusOf(await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } }))).toBe(409);
    expect(statusOf(await call(denyDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } }))).toBe(409);
  });

  it('audits the decision against the flow the start event named', async () => {
    const started = await start();
    const startTarget = (mockAudit.mock.calls[0] as any[])[2].targetId;
    await call(approveDeviceRequest, { user: APPROVER, body: { userCode: started.user_code } });

    const approve = mockAudit.mock.calls.find((c) => c[1] === 'device.authorize.approve') as any[];
    expect(approve[2].targetId).toBe(startTarget);
    expect(approve[2].targetType).toBe('device-authorization');
  });

  it('fails closed when the approving session predates the identity claims', async () => {
    const started = await start();
    const res = await call(approveDeviceRequest, {
      user: { sub: 'user-1', organizationId: 'org-1' }, // no amr/aal/auth_time
      body: { userCode: started.user_code },
    });

    expect(statusOf(res)).toBe(500);
    // The flow is untouched, so the device keeps waiting rather than being granted.
    expect(body(await call(deviceToken, { body: { device_code: started.device_code } })).error).toBe('authorization_pending');
  });
});

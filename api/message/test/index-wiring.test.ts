// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-wiring regression suite for src/index.ts.
 *
 * Imports the REAL boot module and drives real HTTP requests through the
 * assembled Express app. The middleware whose semantics these bugs hinge on is
 * the REAL implementation, loaded straight from the built packages:
 *   - api-core `requireAuth` / `requirePermission` / `requireServicePrincipal`
 *     (real JWT verification) and `requireStepUp` (real single-use jti store,
 *     process-local because no Redis is configured);
 *   - api-server `createAuthenticatedWithOrgRoute` / `createProtectedRoute`
 *     with the real idempotency middleware (in-memory store) and orgId gate.
 * Only infrastructure is replaced: DB-backed services, object storage, the
 * audit transport, platform-HTTP helpers, the tenant-context DB scope, and the
 * createApp/runServer shell. (Loading the full package barrels instead exhausts
 * the jest heap, so the real modules are imported file-by-file.)
 *
 * Locks in two mount-order bugs:
 *   1. restore + purge used to be two separate `requireStepUp` mounts, so a
 *      purge request consumed its single-use step-up jti in the restore mount
 *      and was then rejected as STEP_UP_REPLAY by its own mount — purge could
 *      never succeed.
 *   2. requests that fell through those stacked mounts (purge, and the internal
 *      service routes mounted after them) ran the idempotency middleware once
 *      per chain with the SAME key, so any Idempotency-Key request 409'd against
 *      its own in-flight reservation.
 */

import {
  type AnyFn,
  installTestServiceKeys,
  generateTestSigningKey,
  installTestJwks,
  signTestUserToken,
  type TestSigningKey,
  stubModule,
} from '@pipeline-builder/api-core/testing';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import { apiCoreMock } from './helpers/mock-api-core.js';

/** Any HMAC key — no verifier in the fleet holds one to match it. */
const HS256_SECRET = 'a-shared-secret-nothing-verifies-with';
delete process.env.REDIS_URL;
delete process.env.REDIS_SENTINELS;

const pkg = (rel: string) => new URL(`../../../packages/${rel}`, import.meta.url).href;

const mockFindDeletedById = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRestore = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPurgeById = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPurgeOrgBlobs = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// -- Real api-core middleware (file-level imports, not the heavy barrel) -------
jest.unstable_mockModule('@pipeline-builder/api-core', async () => {
  const auth = await import(pkg('api-core/lib/middleware/auth.js'));
  const stepUp = await import(pkg('api-core/lib/middleware/step-up.js'));
  const response = await import(pkg('api-core/lib/utils/response.js'));
  const errorCodes = await import(pkg('api-core/lib/types/error-codes.js'));
  return apiCoreMock({
    requireAuth: auth.requireAuth,
    requirePermission: auth.requirePermission,
    requireServicePrincipal: auth.requireServicePrincipal,
    isServicePrincipal: auth.isServicePrincipal,
    isSystemAdmin: auth.isSystemAdmin,
    requireStepUp: stepUp.requireStepUp,
    sendError: response.sendError,
    sendSuccess: response.sendSuccess,
    sendBadRequest: response.sendBadRequest,
    sendEntityNotFound: response.sendEntityNotFound,
    ErrorCode: errorCodes.ErrorCode,
    getParam: (p: Record<string, string> | undefined, k: string) => p?.[k],
    // Consumed by the real idempotency / check-quota modules.
    createEnvRedisClient: () => null,
    emitCounter: () => undefined,
    getQuotaServiceAuthHeader: () => '',
    sendQuotaExceeded: () => undefined,
    // Boot-module + router link-time stubs.
    createQuotaService: () => ({ increment: jest.fn<AnyFn>(), check: jest.fn<AnyFn>(), getUsage: jest.fn<AnyFn>() }),
    createEnvSseTicketStore: () => ({ stop: jest.fn<AnyFn>() }),
    SSE_TICKET_TTL_MS: 30_000,
    validateBody: (req: { body?: Record<string, unknown> }) => ({ ok: true, value: req.body ?? {} }),
    validateQuery: () => ({ ok: true, value: {} }),
    parsePaginationParams: () => ({ limit: 25, offset: 0 }),
    sendPaginatedNested: jest.fn<AnyFn>(),
    resolveRecipientAlias: (v: string) => ({ resolvedOrgId: v, wasAlias: false, originalValue: v }),
    MessageCreateSchema: {},
    MessageReplySchema: {},
    MessageEditSchema: {},
    MessageFilterSchema: {},
  });
});

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { IDEMPOTENCY_TTL_MS: 300_000, IDEMPOTENCY_MAX_STORE_SIZE: 10_000, IDEMPOTENCY_CLEANUP_INTERVAL_MS: 60_000 },
}));

// Infra: the DB tenant scope + retention scheduler.
// (`requireActual` can't widen this list — the api-core mock above is an ASYNC
// factory, and pipeline-data loads api-core, so a sync requireActual throws.)
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  // api-server's tenant-context module reads this to stamp the request's org on
  // every log line. `runWithTenantContext` above is a pass-through that opens no
  // real scope, so there is no context to return — undefined leaves log lines
  // unattributed, which is exactly the fail-closed behaviour in production.
  getTenantContext: () => undefined,
  createSoftDeletePurgeScheduler: () => null,
  schema: { message: {} },
}));

// -- Real api-server route chains; stand-ins for the app/server shell ----------
const app = express();
app.use(express.json());
jest.unstable_mockModule('@pipeline-builder/api-server', async () => {
  const factory = await import(pkg('api-server/lib/api/middleware-factory.js'));
  const { getIdentity } = await import(pkg('api-core/lib/utils/identity.js'));
  return stubModule('@pipeline-builder/api-server', {
    createAuthenticatedWithOrgRoute: factory.createAuthenticatedWithOrgRoute,
    createProtectedRoute: factory.createProtectedRoute,
    createApp: () => ({ app, sseManager: { send: jest.fn<AnyFn>(), broadcast: jest.fn<AnyFn>() } }),
    runServer: jest.fn<AnyFn>(),
    postgresHealthCheck: async () => ({}),
    registerSseTicketChannel: jest.fn<AnyFn>(),
    // Pre-auth identity (header-derived), exactly like the real one; requireAuth
    // re-derives it from the verified JWT.
    attachRequestContext: () => (req: any, _res: unknown, next: () => void) => {
      req.context = { identity: getIdentity(req), log: jest.fn<AnyFn>(), requestId: 'req-1' };
      next();
    },
    withRoute: (handler: any) => async (req: any, res: any) => {
      const { orgId = '', userId = '' } = req.context.identity;
      try {
        await handler({ req, res, ctx: req.context, orgId, userId });
      } catch (err: any) {
        res.status(500).json({ message: err?.message ?? String(err) });
      }
    },
    incCounter: () => undefined,
    incrementQuotaFromCtx: jest.fn<AnyFn>(),
    rateLimitByOrg: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  });
});

// -- Service / helper stand-ins -----------------------------------------------
jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: {
    findDeletedById: mockFindDeletedById,
    restore: mockRestore,
    purgeById: mockPurgeById,
    create: mockCreate,
    purgeExpired: jest.fn(async () => 0),
  },
}));
jest.unstable_mockModule('../src/services/attachment-service.js', () => ({
  attachmentService: {
    purgeOrgBlobs: mockPurgeOrgBlobs,
    purgePending: jest.fn(async () => 0),
    linkToMessage: jest.fn(async () => []),
  },
}));
jest.unstable_mockModule('../src/services/attachment-storage.js', () => ({
  deleteAttachment: jest.fn<AnyFn>(),
  getAttachmentStream: jest.fn<AnyFn>(),
  getAttachmentStreamOrNull: jest.fn<AnyFn>(),
  putAttachment: jest.fn<AnyFn>(),
  generateThumbnail: jest.fn<AnyFn>(),
  thumbnailSiblingOf: jest.fn<AnyFn>(),
  thumbnailContentType: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: jest.fn<AnyFn>() }),
}));
jest.unstable_mockModule('../src/helpers/org-names.js', () => ({
  enrichOneWithOrgNames: async <T>(m: T) => m,
  enrichWithOrgNames: async <T>(m: T) => m,
}));
jest.unstable_mockModule('../src/helpers/org-reachability.js', () => ({
  isRecipientReachable: async () => true,
  isTargetUserReachable: async () => true,
  listReachableOrgs: async () => [],
}));

await import('../src/index.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  const tombstone = { id: 'msg-1', orgId: 'org-1', createdBy: 'user-1', threadId: null, messageType: 'conversation' };
  mockFindDeletedById.mockResolvedValue(tombstone);
  mockRestore.mockResolvedValue(tombstone);
  mockPurgeById.mockResolvedValue('msg-1');
  mockCreate.mockResolvedValue({ id: 'msg-new', orgId: 'org-1', recipientOrgId: 'org-1' });
  mockPurgeOrgBlobs.mockResolvedValue(3);
});

/**
 * Minimal HS256 JWT signer. Nothing in the fleet accepts an HMAC token any more
 * (#5 moved user tokens to platform's ES256 key, #14 moved internal service
 * tokens to per-service ES256 keys) — this exists ONLY to mint the forgeries the
 * cases below assert are refused.
 */
function signHs256Jwt(claims: Record<string, unknown>, ttlSeconds: number): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, iat: now, exp: now + ttlSeconds })}`;
  return `${unsigned}.${createHmac('sha256', HS256_SECRET).update(unsigned).digest('base64url')}`;
}

/**
 * Platform's ES256 signing key, published through the JWKS installed here. User
 * and step-up tokens are asymmetric now, so nothing this service holds can mint
 * one — which is exactly the property the last case in this file pins.
 */
const signingKey: TestSigningKey = generateTestSigningKey();
installTestJwks([signingKey]);

/**
 * Real per-service key files (#14): `platform` is the only caller the internal
 * routes admit, `compliance` is a real peer that holds a valid key of its own
 * and must still be turned away.
 */
const serviceKeys = installTestServiceKeys(['platform', 'compliance', 'message']);
serviceKeys.becomeService('message');

/** A platform-signed USER token (access or step-up). */
function signUserJwt(claims: Record<string, unknown>, ttlSeconds: number): string {
  return signTestUserToken(claims, { key: signingKey, expiresIn: ttlSeconds });
}

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;

/**
 * Identity claims every USER token must carry (`principalType` / `token_use`
 * plus the assurance trio) — `requireAuth` fails closed without them, so these
 * payloads mirror exactly what the platform mints.
 */
const USER_CLAIMS = {
  principalType: 'user',
  token_use: 'access',
  amr: ['pwd'],
  aal: 1,
  auth_time: 1_700_000_000,
} as const;

function accessToken(permissions: string[] = ['messages:read', 'messages:write']): string {
  return signUserJwt({
    ...USER_CLAIMS,
    sub: 'user-1',
    role: 'member',
    type: 'access',
    organizationId: 'org-1',
    organizationName: 'org-1',
    permissions,
  }, 300);
}

function stepUpToken(sub = 'user-1'): string {
  return signUserJwt({ type: 'step-up', sub, jti: `su-${uniq()}` }, 60);
}

/**
 * A token from `platform`, minted with platform's OWN key exactly as its process
 * would (#14). The internal routes admit `platform` and nobody else, and the
 * name is bound to the signing key — which `serviceTokenFrom('compliance')`
 * below is used to prove.
 */
function serviceToken(name = 'platform'): string {
  return serviceKeys.sign(name, { organizationId: 'org-1', organizationName: 'org-1' });
}

async function call(method: string, path: string, headers: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-org-id': 'org-1', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
}

describe('restore + purge share ONE step-up chain', () => {
  it('POST /messages/:id/purge succeeds with a fresh step-up token (no STEP_UP_REPLAY)', async () => {
    const res = await call('POST', '/messages/msg-1/purge', {
      'authorization': `Bearer ${await accessToken()}`, 'x-step-up-token': await stepUpToken(),
    });
    expect(res.body?.code).not.toBe('STEP_UP_REPLAY');
    expect(res.status).toBe(200);
    expect(mockPurgeById).toHaveBeenCalledWith('msg-1', 'org-1');
  });

  it('POST /messages/:id/restore succeeds with a fresh step-up token', async () => {
    const res = await call('POST', '/messages/msg-1/restore', {
      'authorization': `Bearer ${await accessToken()}`, 'x-step-up-token': await stepUpToken(),
    });
    expect(res.status).toBe(200);
    expect(mockRestore).toHaveBeenCalledWith('msg-1', 'org-1', 'user-1');
  });

  it('still enforces single-use: replaying a consumed step-up token is STEP_UP_REPLAY', async () => {
    const su = await stepUpToken();
    const first = await call('POST', '/messages/msg-1/restore', { 'authorization': `Bearer ${await accessToken()}`, 'x-step-up-token': su });
    expect(first.status).toBe(200);
    const replay = await call('POST', '/messages/msg-1/purge', { 'authorization': `Bearer ${await accessToken()}`, 'x-step-up-token': su });
    expect(replay.status).toBe(401);
    expect(replay.body?.code).toBe('STEP_UP_REPLAY');
    expect(mockPurgeById).not.toHaveBeenCalled();
  });

  it.each(['restore', 'purge'])('%s without a step-up token → 401 STEP_UP_REQUIRED', async (action) => {
    const res = await call('POST', `/messages/msg-1/${action}`, { authorization: `Bearer ${await accessToken()}` });
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe('STEP_UP_REQUIRED');
  });

  it.each(['restore', 'purge'])('%s without messages:write → 403 (before step-up is consumed)', async (action) => {
    const res = await call('POST', `/messages/msg-1/${action}`, {
      'authorization': `Bearer ${await accessToken(['messages:read'])}`, 'x-step-up-token': await stepUpToken(),
    });
    expect(res.status).toBe(403);
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockPurgeById).not.toHaveBeenCalled();
  });

  it.each(['restore', 'purge'])('%s without auth → 401', async (action) => {
    const res = await call('POST', `/messages/msg-1/${action}`, { 'x-step-up-token': await stepUpToken() });
    expect(res.status).toBe(401);
  });
});

describe('internal routes + idempotency: each request passes one chain', () => {
  it.each(['restore', 'purge'])('POST /messages/:id/%s with an Idempotency-Key is not 409', async (action) => {
    const res = await call('POST', `/messages/msg-1/${action}`, {
      'authorization': `Bearer ${await accessToken()}`, 'x-step-up-token': await stepUpToken(), 'idempotency-key': `k-${uniq()}`,
    });
    expect(res.status).toBe(200);
  });

  // The internal routes used to be mounted AFTER the restore/purge mounts, so
  // they inherited `requirePermission('messages:write')`, which a platform
  // service token (no permission claims) fails — every in-app notification and
  // org blob purge from the platform was 403'd.
  it('POST /messages/internal/notify accepts a platform service token (no leaked user-chain 403)', async () => {
    const res = await call('POST', '/messages/internal/notify', { authorization: `Bearer ${serviceToken()}` },
      { recipientOrgId: 'org-1', subject: 'Join request', content: 'someone wants in' });
    expect(res.status).toBe(201);
  });

  it('DELETE /messages/internal/org/:orgId/attachments accepts a platform service token (no leaked user-chain 403)', async () => {
    const res = await call('DELETE', '/messages/internal/org/org-9/attachments', { authorization: `Bearer ${serviceToken()}` });
    expect(res.status).toBe(200);
  });

  it('POST /messages/internal/notify (service) with an Idempotency-Key is not 409', async () => {
    const res = await call('POST', '/messages/internal/notify', {
      'authorization': `Bearer ${serviceToken()}`, 'idempotency-key': `k-${uniq()}`,
    }, { recipientOrgId: 'org-1', subject: 'Join request', content: 'someone wants in' });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('DELETE /messages/internal/org/:orgId/attachments (service) with an Idempotency-Key is not 409', async () => {
    const res = await call('DELETE', '/messages/internal/org/org-9/attachments', {
      'authorization': `Bearer ${serviceToken()}`, 'idempotency-key': `k-${uniq()}`,
    });
    expect(res.status).toBe(200);
    expect(mockPurgeOrgBlobs).toHaveBeenCalledWith('org-9');
  });

  it('REFUSES another service on an internal route, end to end (#14)', async () => {
    // `compliance` holds a perfectly valid key of its own — it is just not one
    // of the callers these routes admit, and the name is bound to the key it
    // signed with, so it cannot claim to be platform either.
    const res = await call('POST', '/messages/internal/notify', { authorization: `Bearer ${serviceToken('compliance')}` },
      { recipientOrgId: 'org-1', subject: 'Join request', content: 'someone wants in' });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('REFUSES a SUPERADMIN user token on an internal route, end to end (#14)', async () => {
    const res = await call('DELETE', '/messages/internal/org/org-9/attachments', {
      authorization: `Bearer ${await signUserJwt({
        ...USER_CLAIMS,
        sub: 'root',
        role: 'owner',
        type: 'access',
        isSuperAdmin: true,
        organizationId: 'org-1',
        organizationName: 'org-1',
      }, 300)}`,
    });
    expect(res.status).toBe(403);
    expect(mockPurgeOrgBlobs).not.toHaveBeenCalled();
  });

  it('REJECTS an HS256 token that claims to be a user — end to end, through the real middleware', async () => {
    // Before #5 every service held the one shared secret, so any of them could
    // forge a platform-admin session for itself. The token below is shaped
    // exactly like a real access token; the whole request chain must refuse it.
    const forged = signHs256Jwt({
      ...USER_CLAIMS,
      sub: 'user-1',
      role: 'owner',
      type: 'access',
      organizationId: 'org-1',
      isSuperAdmin: true,
      permissions: ['messages:read', 'messages:write'],
    }, 300);
    const res = await call('POST', '/messages/msg-1/purge', {
      'authorization': `Bearer ${forged}`, 'x-step-up-token': await stepUpToken(),
    });
    expect(res.status).toBe(401);
    expect(mockPurgeById).not.toHaveBeenCalled();
  });

  it('REJECTS an HS256 STEP-UP token forged with the shared secret', async () => {
    const forged = signHs256Jwt({ type: 'step-up', sub: 'user-1', jti: `su-${uniq()}` }, 60);
    const res = await call('POST', '/messages/msg-1/purge', {
      'authorization': `Bearer ${await accessToken()}`, 'x-step-up-token': forged,
    });
    expect(res.status).toBe(401);
    expect(res.body?.code).toBe('STEP_UP_INVALID');
    expect(mockPurgeById).not.toHaveBeenCalled();
  });

  it('internal routes still reject a USER token (service-principal gate intact)', async () => {
    const res = await call('DELETE', '/messages/internal/org/org-9/attachments', { authorization: `Bearer ${await accessToken()}` });
    expect(res.status).toBe(403);
    expect(mockPurgeOrgBlobs).not.toHaveBeenCalled();
  });

  it('the idempotency middleware is live: a replayed key returns the cached response', async () => {
    const headers = { 'authorization': `Bearer ${await accessToken()}`, 'idempotency-key': `k-${uniq()}` };
    const body = { recipientOrgId: 'org-1', messageType: 'conversation', subject: 'hi', content: 'hello', priority: 'normal' };
    const first = await call('POST', '/messages', headers, body);
    expect(first.status).toBe(201);
    const second = await call('POST', '/messages', headers, body);
    expect(second.status).toBe(201);
    expect(second.headers['x-idempotent-replayed']).toBe('true');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route tests for the six `/internal/plugin-publications*` routes — the plugin
 * service's handle on the read-only `public/*` namespace (plugin ecosystem §3.3):
 * publish, resign, yank, gc, verify and verify-cache/invalidate.
 *
 * The publishing service is mocked; the router runs on a real Express app over
 * HTTP behind the REAL api-core `requireInternalService` gate (only the body of
 * the service is stubbed), so caller gating, validation, org binding, error
 * mapping, metrics and audit emission are exercised as shipped.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock());
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    registry: { host: 'registry', port: 5000, http: true, insecure: false },
    pluginSigning: { mode: 'local', keyFile: '/nonexistent', kmsKeyId: '', timeoutMs: 1000 },
  },
}));

class PublicationConflictError extends Error {}
class PublicationNotFoundError extends Error {}
class SourceVerificationError extends Error {}
const publishPublicImage = jest.fn<(p: Record<string, unknown>) => Promise<{ imageRepository: string; digest: string; alreadyPublished: boolean }>>();
const resignPublicImageOp = jest.fn<(p: Record<string, unknown>) => Promise<void>>();
const reportResignProgress = jest.fn();
const yankPublicVersion = jest.fn<(repo: string, version: string, digest: string) => Promise<{ alreadyYanked: boolean }>>();
const retagPublicVersion = jest.fn<(repo: string, version: string, digest: string) => Promise<{ alreadyTagged: boolean }>>();
const gcPublicImage = jest.fn<(repo: string, digest: string) => Promise<{ deleted: boolean }>>();
const verifyPublication = jest.fn<(repo: string, digest: string) => Promise<unknown>>();
const invalidateVerifyCache = jest.fn<(repo?: string, digest?: string) => number>();
const PublicationMetrics = {
  PUBLISH: 'registry_public_publish_total',
  RESIGN: 'registry_public_resign_total',
  YANK: 'registry_public_yank_total',
  GC: 'registry_public_gc_total',
  VERIFY: 'registry_public_verify_total',
};
jest.unstable_mockModule('../src/services/public-publishing.js', () => ({
  PublicationConflictError,
  PublicationNotFoundError,
  SourceVerificationError,
  PublicationMetrics,
  TRUST_TIERS: ['official', 'verified', 'community', 'unverified'],
  publishPublicImage,
  resignPublicImageOp,
  reportResignProgress,
  yankPublicVersion,
  retagPublicVersion,
  gcPublicImage,
  verifyPublication,
  invalidateVerifyCache,
}));

const publicationOwner = jest.fn<(repo: string) => Promise<string | null>>();
jest.unstable_mockModule('../src/services/public-publications.js', () => ({ publicationOwner }));

const emitImageRegistryAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitImageRegistryAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

const incCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter,
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      if (!r.headersSent) r.status(500).json({ success: false, message: (err as Error)?.message });
    }
  },
}));

/** Every audited() declaration, so the declared action per route can be asserted. */
const auditedActions: string[] = [];
type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  audited: (action: string) => {
    auditedActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  actorId: () => 'system',
  // requireInternalService is NOT overridden: the real api-core gate runs.
}));

const express = (await import('express')).default;
const { registerPublicationRoutes, PLUGIN_PUBLICATIONS_PATH } = await import('../src/routes/internal-publications.js');
const { PluginSigningError } = await import('../src/services/plugin-signing.js');

const SYSTEM_ORG = '000000000000000000000001';
const ORG = '6650f0c3a1b2c3d4e5f60718';
const OTHER_ORG = 'deadbeefdeadbeefdeadbeef';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const REPO = 'public/acme/scanner';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth. Default: the plugin SERVICE principal minted for the
  // system org; headers let a test become another service, a user, or anonymous.
  app.use((req, _res, next) => {
    const as = req.header('x-test-as') ?? 'service:plugin';
    if (as !== 'anonymous') {
      const isService = as.startsWith('service:');
      (req as { user?: unknown }).user = {
        principalType: isService ? 'service' : 'user',
        sub: isService ? as : 'user-1',
        isSuperAdmin: req.header('x-test-superadmin') === 'true',
        organizationId: req.header('x-test-org') ?? SYSTEM_ORG,
      };
    }
    next();
  });
  const router = express.Router();
  registerPublicationRoutes(router);
  app.use('/internal', router);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  publishPublicImage.mockImplementation(async (p) => ({
    imageRepository: `public/${p.publisherHandle as string}/${p.name as string}`, digest: p.digest as string, alreadyPublished: false,
  }));
  resignPublicImageOp.mockResolvedValue(undefined);
  yankPublicVersion.mockResolvedValue({ alreadyYanked: false });
  retagPublicVersion.mockResolvedValue({ alreadyTagged: false });
  gcPublicImage.mockResolvedValue({ deleted: true });
  verifyPublication.mockResolvedValue({ signed: true, tier: 'verified', publisher: 'acme' });
  invalidateVerifyCache.mockReturnValue(2);
  publicationOwner.mockResolvedValue(ORG);
});

type Headers = Record<string, string>;
const call = async (method: 'GET' | 'POST', path: string, body?: unknown, headers: Headers = {}) => {
  const res = await fetch(`${baseUrl}/internal${PLUGIN_PUBLICATIONS_PATH}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const post = (path: string, body: unknown, headers?: Headers) => call('POST', path, body, headers);

const publishBody = (over: Record<string, unknown> = {}) => ({
  sourceRepository: `org-${ORG}/scanner`,
  digest: DIGEST,
  publisherHandle: 'acme',
  name: 'scanner',
  version: '1.2.0',
  tier: 'verified',
  publisherOrgId: ORG,
  ...over,
});

// -----------------------------------------------------------------------------
// caller gate
// -----------------------------------------------------------------------------

describe('caller gate (requireInternalService, plugin only)', () => {
  const routes: Array<[string, 'GET' | 'POST', string, unknown]> = [
    ['publish', 'POST', '', publishBody()],
    ['resign', 'POST', '/resign', { imageRepository: REPO, digest: DIGEST, publisherHandle: 'acme', tier: 'official' }],
    ['yank', 'POST', '/yank', { imageRepository: REPO, version: '1.2.0', digest: DIGEST }],
    ['retag', 'POST', '/retag', { imageRepository: REPO, version: '1.2.0', digest: DIGEST }],
    ['gc', 'POST', '/gc', { imageRepository: REPO, digest: DIGEST }],
    ['verify', 'GET', `/verify?imageRepository=${encodeURIComponent(REPO)}&digest=${DIGEST}`, undefined],
    ['invalidate', 'POST', '/verify-cache/invalidate', {}],
  ];
  const services = [publishPublicImage, resignPublicImageOp, yankPublicVersion, retagPublicVersion, gcPublicImage, verifyPublication, invalidateVerifyCache];

  it.each(routes)('%s refuses another internal service (403)', async (_l, method, path, body) => {
    const { status, body: res } = await call(method, path, body, { 'x-test-as': 'service:pipeline' });
    expect(status).toBe(403);
    expect(res.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it.each(routes)('%s refuses a user token, even a superadmin (403)', async (_l, method, path, body) => {
    const { status } = await call(method, path, body, { 'x-test-as': 'user', 'x-test-superadmin': 'true' });
    expect(status).toBe(403);
  });

  it.each(routes)('%s refuses an anonymous caller (401)', async (_l, method, path, body) => {
    const { status } = await call(method, path, body, { 'x-test-as': 'anonymous' });
    expect(status).toBe(401);
  });

  it('never reaches the publishing service for a refused caller', async () => {
    for (const [, method, path, body] of routes) await call(method, path, body, { 'x-test-as': 'service:platform' });
    for (const fn of services) expect(fn).not.toHaveBeenCalled();
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it('declares the audit action of every mutating route', () => {
    expect(auditedActions).toEqual(['registry.image.publish', 'registry.image.resign', 'registry.image.yank', 'registry.image.publish', 'registry.image.gc']);
  });
});

// -----------------------------------------------------------------------------
// publish
// -----------------------------------------------------------------------------

describe('POST /internal/plugin-publications', () => {
  it('publishes, counts it, and audits it against the publisher org', async () => {
    const { status, body } = await post('', publishBody());
    expect(status).toBe(200);
    expect(body.data).toEqual({ imageRepository: REPO, digest: DIGEST });
    expect(publishPublicImage).toHaveBeenCalledWith(publishBody());
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.PUBLISH, { outcome: 'success' });
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.publish',
      orgId: SYSTEM_ORG,
      affectedOrgId: ORG,
      outcome: 'success',
      targetType: 'registry-image',
      targetId: REPO,
      details: expect.objectContaining({
        repo: REPO, source: `org-${ORG}/scanner`, digest: DIGEST, version: '1.2.0', tier: 'verified', publisher: 'acme', alreadyPublished: false,
      }),
    }));
  });

  it('counts an idempotent re-publish as republished', async () => {
    publishPublicImage.mockResolvedValue({ imageRepository: REPO, digest: DIGEST, alreadyPublished: true });
    await post('', publishBody());
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.PUBLISH, { outcome: 'republished' });
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ alreadyPublished: true }) }));
  });

  it('lets the SOURCE org\'s own service token publish its image', async () => {
    const { status } = await post('', publishBody(), { 'x-test-org': ORG.toUpperCase() });
    expect(status).toBe(200);
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG }));
  });

  it('refuses a token minted for a third org (403 ORG_MISMATCH)', async () => {
    const { status, body } = await post('', publishBody(), { 'x-test-org': OTHER_ORG });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(publishPublicImage).not.toHaveBeenCalled();
  });

  it('refuses a tenant token publishing from system/* (only the system org owns it)', async () => {
    const { status } = await post('', publishBody({ sourceRepository: 'system/scanner', publisherOrgId: null }), { 'x-test-org': ORG });
    expect(status).toBe(403);
  });

  // Anonymous submissions (plugin ecosystem §4.2 / W5): an approved submission is
  // published from its quarantined build to public/community/<name>.
  it('publishes an approved submission from quarantine/<id> for the system org', async () => {
    const source = 'quarantine/0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';
    const body = publishBody({ sourceRepository: source, publisherHandle: 'community', tier: 'unverified', publisherOrgId: null });
    const { status } = await post('', body);
    expect(status).toBe(200);
    expect(publishPublicImage).toHaveBeenCalledWith(body);
  });

  it('refuses a tenant token publishing from quarantine/* (the system org decides moderation)', async () => {
    const source = 'quarantine/0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';
    const { status } = await post('', publishBody({ sourceRepository: source, publisherOrgId: null }), { 'x-test-org': ORG });
    expect(status).toBe(403);
    expect(publishPublicImage).not.toHaveBeenCalled();
  });

  it('refuses another internal service publishing from quarantine/*', async () => {
    const source = 'quarantine/0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';
    const { status } = await post('', publishBody({ sourceRepository: source, publisherOrgId: null }), { 'x-test-as': 'service:pipeline' });
    expect(status).toBe(403);
    expect(publishPublicImage).not.toHaveBeenCalled();
  });

  it('rejects a malformed quarantine source (dots / nested path)', async () => {
    const { status } = await post('', publishBody({ sourceRepository: 'quarantine/a.b', publisherOrgId: null }));
    expect(status).toBe(400);
  });

  it('omits affectedOrgId for an unattributed (platform-absorbed) publication', async () => {
    const { status } = await post('', publishBody({ sourceRepository: 'system/scanner', publisherOrgId: null }));
    expect(status).toBe(200);
    expect(emitImageRegistryAudit.mock.calls[0][0]).not.toHaveProperty('affectedOrgId');
  });

  it.each([
    ['a public/* source (republishing the public copy)', { sourceRepository: 'public/acme/scanner' }],
    ['a non-plugin source', { sourceRepository: 'library/base' }],
    ['a tag instead of a digest', { digest: '1.2.0' }],
    ['a short digest', { digest: 'sha256:abc' }],
    ['an uppercase handle', { publisherHandle: 'Acme' }],
    ['a multi-component handle', { publisherHandle: 'acme/evil' }],
    ['a traversal plugin name', { name: '../system' }],
    ['a version that looks like a cosign signature tag', { version: `sha256-${'a'.repeat(64)}.sig` }],
    ['a version with a slash', { version: '1.0/x' }],
    ['an unknown tier', { tier: 'platinum' }],
    ['a malformed publisherOrgId', { publisherOrgId: '../x' }],
    ['a missing publisherOrgId (must be explicit, null for unattributed)', { publisherOrgId: undefined }],
  ])('rejects %s (400)', async (_label, over) => {
    const { status, body } = await post('', publishBody(over));
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(publishPublicImage).not.toHaveBeenCalled();
  });

  it.each([
    ['a conflicting re-publish', () => new PublicationConflictError('immutable'), 409, 'CONFLICT', 'conflict'],
    ['a digest missing from the source', () => new PublicationNotFoundError('No manifest'), 404, 'NOT_FOUND', 'failure'],
    ['an unverifiable source SBOM', () => new SourceVerificationError('no SBOM'), 409, 'IMAGE_VERIFICATION_FAILED', 'failure'],
    ['a cosign failure', () => new PluginSigningError('cosign sign failed'), 502, 'SERVICE_UNAVAILABLE', 'failure'],
  ])('maps %s to its HTTP status + code and audits nothing', async (_label, make, status, code, outcome) => {
    publishPublicImage.mockRejectedValue(make());
    const res = await post('', publishBody());
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.PUBLISH, { outcome });
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it('lets an unexpected error fall through to the route error handler (500)', async () => {
    publishPublicImage.mockRejectedValue(new Error('kaboom'));
    const { status } = await post('', publishBody());
    expect(status).toBe(500);
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// resign
// -----------------------------------------------------------------------------

describe('POST /internal/plugin-publications/resign', () => {
  const body = (over: Record<string, unknown> = {}) => ({ imageRepository: REPO, digest: DIGEST, publisherHandle: 'acme', tier: 'official', ...over });

  it('re-signs and audits against the recorded owner org', async () => {
    const res = await post('/resign', body());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ imageRepository: REPO, digest: DIGEST, tier: 'official', publisher: 'acme' });
    expect(resignPublicImageOp).toHaveBeenCalledWith(body());
    expect(publicationOwner).toHaveBeenCalledWith(REPO);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.RESIGN, { outcome: 'success' });
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.resign',
      affectedOrgId: ORG,
      targetId: REPO,
      details: { repo: REPO, digest: DIGEST, tier: 'official', publisher: 'acme' },
    }));
    expect(reportResignProgress).not.toHaveBeenCalled();
  });

  it('audits an ownership transfer against the NEW owner (no record lookup)', async () => {
    await post('/resign', body({ publisherOrgId: 'neworg' }));
    expect(publicationOwner).not.toHaveBeenCalled();
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({ affectedOrgId: 'neworg' }));
  });

  it('omits affectedOrgId when the owner record is unreadable', async () => {
    publicationOwner.mockRejectedValue(new Error('records down'));
    const res = await post('/resign', body());
    expect(res.status).toBe(200);
    expect(emitImageRegistryAudit.mock.calls[0][0]).not.toHaveProperty('affectedOrgId');
  });

  it('reports re-sign job progress on success AND on failure', async () => {
    await post('/resign', body({ progress: { completed: 4, total: 9 } }));
    expect(reportResignProgress).toHaveBeenCalledWith({ completed: 4, total: 9 });
    resignPublicImageOp.mockRejectedValue(new PublicationNotFoundError('gone'));
    const res = await post('/resign', body({ progress: { completed: 5, total: 9 } }));
    expect(res.status).toBe(404);
    expect(reportResignProgress).toHaveBeenLastCalledWith({ completed: 5, total: 9 });
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.RESIGN, { outcome: 'failure' });
  });

  it('maps a cosign failure to 502 and an unexpected error to 500, auditing neither', async () => {
    resignPublicImageOp.mockRejectedValueOnce(new PluginSigningError('cosign down'));
    expect((await post('/resign', body())).status).toBe(502);
    resignPublicImageOp.mockRejectedValueOnce(new Error('kaboom'));
    expect((await post('/resign', body())).status).toBe(500);
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['a private repository', { imageRepository: `org-${ORG}/scanner` }],
    ['a registry-meta repository', { imageRepository: 'registry-meta/publications/acme/scanner' }],
    ['a nested public path', { imageRepository: 'public/acme/x/y' }],
    ['a bad digest', { digest: 'latest' }],
    ['a bad tier', { tier: 'gold' }],
    ['negative progress', { progress: { completed: -1, total: 3 } }],
    ['fractional progress', { progress: { completed: 1.5, total: 3 } }],
  ])('rejects %s (400)', async (_label, over) => {
    const res = await post('/resign', body(over));
    expect(res.status).toBe(400);
    expect(resignPublicImageOp).not.toHaveBeenCalled();
    expect(reportResignProgress).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// yank
// -----------------------------------------------------------------------------

describe('POST /internal/plugin-publications/retag', () => {
  const body = (over: Record<string, unknown> = {}) => ({ imageRepository: REPO, version: '1.2.0', digest: DIGEST, ...over });

  it('re-tags the version and audits it as a publish against the owner org', async () => {
    const res = await post('/retag', body());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ imageRepository: REPO, version: '1.2.0', digest: DIGEST, tagged: true });
    expect(retagPublicVersion).toHaveBeenCalledWith(REPO, '1.2.0', DIGEST);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.PUBLISH, { outcome: 'retagged' });
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.publish', affectedOrgId: ORG, details: { repo: REPO, version: '1.2.0', digest: DIGEST, retag: true },
    }));
  });

  it('succeeds idempotently for a tag already in place, without an audit', async () => {
    retagPublicVersion.mockResolvedValue({ alreadyTagged: true });
    const res = await post('/retag', body());
    expect(res.status).toBe(200);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.PUBLISH, { outcome: 'republished' });
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it('maps an immutable-tag conflict to 409 and a missing digest to 404', async () => {
    retagPublicVersion.mockRejectedValueOnce(new PublicationConflictError('points elsewhere'));
    expect((await post('/retag', body())).status).toBe(409);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.PUBLISH, { outcome: 'conflict' });
    retagPublicVersion.mockRejectedValueOnce(new PublicationNotFoundError('gone'));
    expect((await post('/retag', body())).status).toBe(404);
  });

  it('rethrows an unexpected failure (500)', async () => {
    retagPublicVersion.mockRejectedValueOnce(new Error('registry down'));
    expect((await post('/retag', body())).status).toBe(500);
  });

  it('validates the body', async () => {
    expect((await post('/retag', body({ imageRepository: 'org-x/scanner' }))).status).toBe(400);
  });
});

describe('POST /internal/plugin-publications/yank', () => {
  const body = (over: Record<string, unknown> = {}) => ({ imageRepository: REPO, version: '1.2.0', digest: DIGEST, ...over });

  it('yanks the tag and audits it against the owner org', async () => {
    const res = await post('/yank', body());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ imageRepository: REPO, version: '1.2.0', digest: DIGEST, yanked: true });
    expect(yankPublicVersion).toHaveBeenCalledWith(REPO, '1.2.0', DIGEST);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.YANK, { outcome: 'success' });
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.yank',
      affectedOrgId: ORG,
      targetId: REPO,
      details: { repo: REPO, version: '1.2.0', digest: DIGEST },
    }));
  });

  it('succeeds idempotently for an already-yanked version, without a second audit', async () => {
    yankPublicVersion.mockResolvedValue({ alreadyYanked: true });
    const res = await post('/yank', body());
    expect(res.status).toBe(200);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.YANK, { outcome: 'already_yanked' });
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it('omits affectedOrgId for an unattributed listing', async () => {
    publicationOwner.mockResolvedValue(null);
    await post('/yank', body());
    expect(emitImageRegistryAudit.mock.calls[0][0]).not.toHaveProperty('affectedOrgId');
  });

  it('omits affectedOrgId when the owner record is unreadable', async () => {
    publicationOwner.mockRejectedValue(new Error('records down'));
    expect((await post('/yank', body())).status).toBe(200);
    expect(emitImageRegistryAudit.mock.calls[0][0]).not.toHaveProperty('affectedOrgId');
  });

  it('maps a stale-digest conflict to 409', async () => {
    yankPublicVersion.mockRejectedValue(new PublicationConflictError('points at another digest'));
    const res = await post('/yank', body());
    expect(res.status).toBe(409);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.YANK, { outcome: 'conflict' });
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it('counts an unexpected failure and returns 500', async () => {
    yankPublicVersion.mockRejectedValue(new Error('kaboom'));
    expect((await post('/yank', body())).status).toBe(500);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.YANK, { outcome: 'failure' });
  });

  it.each([
    ['a private repository', { imageRepository: `org-${ORG}/scanner` }],
    ['a cosign companion tag as the version', { version: `sha256-${'a'.repeat(64)}.att` }],
    ['a missing version', { version: undefined }],
    ['a bad digest', { digest: 'sha256:zz' }],
  ])('rejects %s (400)', async (_label, over) => {
    expect((await post('/yank', body(over))).status).toBe(400);
    expect(yankPublicVersion).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// gc
// -----------------------------------------------------------------------------

describe('POST /internal/plugin-publications/gc', () => {
  const body = (over: Record<string, unknown> = {}) => ({ imageRepository: REPO, digest: DIGEST, ...over });

  it('collects the digest and audits it against the owner looked up BEFORE the delete', async () => {
    const res = await post('/gc', body());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ imageRepository: REPO, digest: DIGEST, deleted: true });
    expect(publicationOwner.mock.invocationCallOrder[0]).toBeLessThan(gcPublicImage.mock.invocationCallOrder[0]);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.GC, { outcome: 'success' });
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.gc', affectedOrgId: ORG, targetId: REPO, details: { repo: REPO, digest: DIGEST },
    }));
  });

  it('succeeds without an audit for an already-collected digest', async () => {
    gcPublicImage.mockResolvedValue({ deleted: false });
    const res = await post('/gc', body());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: false });
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.GC, { outcome: 'already_deleted' });
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it('refuses (409) a digest a tag still references', async () => {
    gcPublicImage.mockRejectedValue(new PublicationConflictError('still referenced by tag 1.2.0'));
    const res = await post('/gc', body());
    expect(res.status).toBe(409);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.GC, { outcome: 'conflict' });
    expect(emitImageRegistryAudit).not.toHaveBeenCalled();
  });

  it('audits without affectedOrgId when the owner record is unreadable, and 500s an unexpected failure', async () => {
    publicationOwner.mockRejectedValue(new Error('records down'));
    expect((await post('/gc', body())).status).toBe(200);
    expect(emitImageRegistryAudit.mock.calls[0][0]).not.toHaveProperty('affectedOrgId');
    gcPublicImage.mockRejectedValue(new Error('kaboom'));
    expect((await post('/gc', body())).status).toBe(500);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.GC, { outcome: 'failure' });
  });

  it.each([
    ['a private repository (GC here never reaches org namespaces)', { imageRepository: `org-${ORG}/scanner` }],
    ['a system repository', { imageRepository: 'system/scanner' }],
    ['a tag instead of a digest', { digest: '1.2.0' }],
  ])('rejects %s (400)', async (_label, over) => {
    expect((await post('/gc', body(over))).status).toBe(400);
    expect(gcPublicImage).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// verify + invalidate
// -----------------------------------------------------------------------------

describe('GET /internal/plugin-publications/verify', () => {
  const q = (repo: string, digest: string) => `/verify?imageRepository=${encodeURIComponent(repo)}&digest=${encodeURIComponent(digest)}`;

  it('returns the verification result', async () => {
    const res = await call('GET', q(REPO, DIGEST));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ signed: true, tier: 'verified', publisher: 'acme' });
    expect(verifyPublication).toHaveBeenCalledWith(REPO, DIGEST);
  });

  it.each([
    ['a private repository', q(`org-${ORG}/scanner`, DIGEST)],
    ['a bad digest', q(REPO, 'latest')],
    ['no query at all', '/verify'],
  ])('rejects %s (400)', async (_label, path) => {
    expect((await call('GET', path)).status).toBe(400);
    expect(verifyPublication).not.toHaveBeenCalled();
  });

  it('maps a cosign infrastructure failure to 502 and anything else to 500', async () => {
    verifyPublication.mockRejectedValueOnce(new PluginSigningError('cosign missing'));
    expect((await call('GET', q(REPO, DIGEST))).status).toBe(502);
    verifyPublication.mockRejectedValueOnce(new Error('kaboom'));
    expect((await call('GET', q(REPO, DIGEST))).status).toBe(500);
  });
});

describe('POST /internal/plugin-publications/verify-cache/invalidate', () => {
  it.each([
    ['everything', {}, [undefined, undefined]],
    ['one repository', { imageRepository: REPO }, [REPO, undefined]],
    ['one image', { imageRepository: REPO, digest: DIGEST }, [REPO, DIGEST]],
  ])('invalidates %s', async (_label, reqBody, args) => {
    const res = await post('/verify-cache/invalidate', reqBody);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ invalidated: 2 });
    expect(invalidateVerifyCache).toHaveBeenCalledWith(...args);
  });

  it.each([
    ['a digest without a repository', { digest: DIGEST }],
    ['a private repository', { imageRepository: `org-${ORG}/scanner` }],
    ['a bad digest', { imageRepository: REPO, digest: 'x' }],
  ])('rejects %s (400)', async (_label, reqBody) => {
    expect((await post('/verify-cache/invalidate', reqBody)).status).toBe(400);
    expect(invalidateVerifyCache).not.toHaveBeenCalled();
  });
});

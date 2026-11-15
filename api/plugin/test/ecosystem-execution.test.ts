// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Running approved requests outside the deciding HTTP request
 * (services/ecosystem/execution.ts): a publish that outlasts the request
 * carries on and completes, a transient failure keeps the approval (the
 * bootstrap exception's included) and is retried, a refusal hands the request
 * back, a failure that persists is given up on, and two runs of one request
 * never overlap.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

import { DIGEST_A, SYSTEM_ORG, loader, moderator, pluginRow, seedPublishers, setupEcosystemHarness, tenant, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const requestsSvc = await import('../src/services/ecosystem/requests.js');
const decisions = await import('../src/services/ecosystem/decisions.js');
const bootstrap = await import('../src/services/ecosystem/bootstrap.js');
const execution = await import('../src/services/ecosystem/execution.js');
const { RegistryPublicationError } = await import('../src/services/ecosystem/registry.js');
const { ConflictError } = await import('@pipeline-builder/api-core');
await wireEcosystemHarness(h);
const { db } = h;

const MOD_A = moderator('mod-a') as any;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ok = async (path: string, body: any) => ({
  statusCode: 200,
  body: { data: path.endsWith('/plugin-publications') ? { imageRepository: `public/${body.publisherHandle}/${body.name}`, digest: body.digest } : {} },
});

/** Run the retry sweep as if `ms` had passed. */
async function sweepAfter(ms: number) {
  execution.setExecutionClockForTests(() => new Date(Date.now() + ms));
  try {
    return await execution.runDueExecutions();
  } finally {
    execution.setExecutionClockForTests();
  }
}

const requestRow = (id: string) => db.tables.plugin_publish_requests!.find((r) => r.id === id)!;

async function tenantNewListing() {
  const plugin = db.seed('plugins', pluginRow());
  return (await requestsSvc.submit(tenant() as any, { kind: 'new_listing', pluginId: plugin.id })).request;
}

beforeEach(() => {
  db.reset();
  h.registryPost.mockReset().mockImplementation(ok);
  h.audit.mockClear();
  h.notify.mockClear();
  h.membership.mockReset().mockResolvedValue(false as never);
  h.quota.getTierStrict.mockResolvedValue('team' as never);
});

afterEach(() => {
  execution.setInlineBudgetForTests();
  execution.setExecutionClockForTests();
  execution.setExecutionLockForTests(null);
});

describe('a publish that outlasts the deciding request', () => {
  it('answers "publishing", completes in the background, and only then audits and notifies', async () => {
    seedPublishers(db);
    const request = await tenantNewListing();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.registryPost.mockImplementationOnce(async (path: string, body: any) => { await gate; return ok(path, body); });
    execution.setInlineBudgetForTests(20);

    const out = await decisions.approve(MOD_A, request.id, 'ship it');

    expect(out).toMatchObject({ executed: false, executing: 'publishing' });
    expect(requestRow(request.id)).toMatchObject({ status: 'approved' });
    expect(h.audit.mock.calls.some(([e]: any[]) => e.action === 'plugin.request.approve')).toBe(false);

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestRow(request.id).executedAt).toBeInstanceOf(Date);
    expect(db.tables.plugin_listings).toHaveLength(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.approve' }));
    expect(h.notify).toHaveBeenCalledWith('N25', expect.anything(), expect.objectContaining({ text: expect.stringContaining('ship it') }), {});
  });
});

describe('the bootstrap exception survives a transient failure', () => {
  it('keeps the automatic approval through a registry timeout, retries it, and counts it once it publishes', async () => {
    seedPublishers(db);
    const lint = db.seed('plugins', pluginRow({ orgId: SYSTEM_ORG, createdBy: 'sa-loader' }));
    h.registryPost.mockImplementationOnce(async () => { throw new Error('Request timeout after 600000ms'); });

    const first = await requestsSvc.submitAfterBuild(loader() as any, lint.id);

    expect(first).toMatchObject({ ok: true, status: 'approved' });
    const row = db.tables.plugin_publish_requests![0]!;
    expect(row.payload).toMatchObject({ bootstrap: true, execution: expect.objectContaining({ flavor: 'auto', attempts: 1, lastError: expect.stringContaining('image-registry unreachable') }) });
    expect((await bootstrap.bootstrapState()).approved).toBe(0);

    // Not due yet: the first retry waits 30 seconds.
    expect(await sweepAfter(10_000)).toEqual({ ran: 0, executed: 0 });
    // The window may close meanwhile; the claim was taken while it was open.
    await bootstrap.closeBootstrap('window_elapsed', 'system');
    expect(await sweepAfter(MINUTE)).toEqual({ ran: 1, executed: 1 });

    expect(db.tables.plugin_listing_versions![0]).toMatchObject({ imageRepository: 'public/pipeline-builder/lint', imageDigest: DIGEST_A });
    expect((await bootstrap.bootstrapState()).approved).toBe(1);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.request.auto-approve', details: expect.objectContaining({ bootstrap: true }) }));
  });
});

describe('retry schedule', () => {
  it('backs off, and gives up after a day, handing the request back with why', async () => {
    seedPublishers(db);
    const request = await tenantNewListing();
    h.registryPost.mockImplementation(async () => ({ statusCode: 503, body: { message: 'busy' } }));

    await expect(decisions.approve(MOD_A, request.id, null)).resolves.toMatchObject({ executed: false, executing: 'retrying' });
    expect(await sweepAfter(MINUTE)).toEqual({ ran: 1, executed: 0 });
    const state = (requestRow(request.id).payload as any).execution;
    expect(state.attempts).toBe(2);
    // Second retry: 60s after the one just made.
    expect(new Date(state.nextAttemptAt).getTime() - Date.now()).toBeGreaterThan(MINUTE + 50_000);

    expect(await sweepAfter(25 * HOUR)).toEqual({ ran: 1, executed: 0 });
    expect(requestRow(request.id)).toMatchObject({ status: 'pending', decidedBy: null });
    expect((requestRow(request.id).payload as any).executionError).toMatch(/HTTP 503/);
  });
});

describe('locking', () => {
  it('skips a request another run holds, and runs it once that run is gone', async () => {
    seedPublishers(db);
    const request = await tenantNewListing();
    const held = new Set<string>();
    const redis = {
      set: jest.fn(async (key: string) => (held.has(key) ? null : (held.add(key), 'OK'))),
      get: jest.fn(async () => null),
      del: jest.fn(async (key: string) => { held.delete(key); return 1; }),
    };
    execution.setExecutionLockForTests(() => redis as any);
    held.add(`plugin:ecosystem-execute:${request.id}:leader`);

    await expect(decisions.approve(MOD_A, request.id, null)).resolves.toMatchObject({ executed: false, executing: 'publishing' });
    expect(h.registryPost).not.toHaveBeenCalled();
    expect(await sweepAfter(2 * MINUTE)).toEqual({ ran: 0, executed: 0 });

    held.clear();
    expect(await sweepAfter(2 * MINUTE)).toEqual({ ran: 1, executed: 1 });
    expect(requestRow(request.id).executedAt).toBeInstanceOf(Date);
  });
});

describe('which failures are retried', () => {
  it.each([
    ['a transport failure', new RegistryPublicationError('unreachable', 0), true],
    ['a registry 5xx', new RegistryPublicationError('refused', 503), true],
    ['a registry 409', new RegistryPublicationError('refused', 409), false],
    ['a domain refusal', new ConflictError('no longer passes its checks'), false],
    ['a unique violation', Object.assign(new Error('duplicate key'), { code: '23505' }), false],
    ['an unclassified error (a database blip)', new Error('connection reset'), true],
  ])('%s', (_label, err, transient) => {
    expect(execution.isTransient(err)).toBe(transient);
  });
});

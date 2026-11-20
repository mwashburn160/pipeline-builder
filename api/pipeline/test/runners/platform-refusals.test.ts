// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's own refusals at delivery time (the pause toggle flipped
 * mid-job, the owning org's key missing or unreadable) are never the runner's
 * doing: they never touch its health, a paused delivery stays queued, and
 * discovery answers the platform code instead of "not found" (and records
 * nothing misleading on the registry row). A background probe that fails
 * unexpectedly never leaves the row `checking`.
 */

import { jest, describe, expect, it, beforeEach } from '@jest/globals';

const mockFindById = jest.fn<(id: string, orgId: string) => Promise<unknown>>();
jest.unstable_mockModule('../../src/services/pipeline-service.js', () => ({ pipelineService: { findById: mockFindById } }));

const { processDelivery } = await import('../../src/runners/lifecycle.js');
const { routeExecution } = await import('../../src/runners/execution-routing.js');
const { probeRunnerLink, RunnerRouteError } = await import('../../src/runners/routing.js');
const { ORG, PIPE, runnerRow, testDeps } = await import('../helpers/runner-fakes.js');

type Deps = ReturnType<typeof testDeps>;
const keyError = (code: string) => async () => { throw new RunnerRouteError(code as 'RUNNER_KEY_MISSING', 'no key'); };

async function queuedStart(deps: Deps, over: Parameters<typeof runnerRow>[0] = {}) {
  const runner = runnerRow(over);
  deps.store.runners.set(runner.id, runner);
  deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null });
  const req = await deps.store.insertRequest({
    orgId: ORG,
    pipelineId: PIPE,
    action: 'start',
    requestedBy: 'user-1',
    requestedAt: new Date(deps.clock.t),
    expiresAt: new Date(deps.clock.t + 600_000),
    runnerId: runner.id,
  });
  return { runner, req };
}

beforeEach(() => {
  mockFindById.mockReset();
  mockFindById.mockResolvedValue({ id: PIPE });
});

describe('delivery-time platform refusals', () => {
  it.each(['RUNNER_KEY_MISSING', 'RUNNER_KEY_UNREADABLE'])('%s fails the request with that code and leaves the runner\'s health alone', async (code) => {
    const deps = testDeps();
    const { runner, req } = await queuedStart(deps, { consecutiveFailures: 2, lastDeliveryAt: null });
    deps.signerFor = keyError(code);
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'failed', errorCode: code });
    expect(deps.store.runners.get(runner.id)).toMatchObject({ consecutiveFailures: 2, lastDeliveryAt: null, health: 'healthy' });
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('the pause toggle flipped mid-job keeps the request queued (the sweep re-kicks it on resume)', async () => {
    const deps = testDeps({ deliveriesPaused: async () => true });
    const { runner, req } = await queuedStart(deps, { consecutiveFailures: 1, lastDeliveryAt: null });
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'queued', lastDeliveryError: 'RUNNERS_UNAVAILABLE' });
    expect(deps.store.requests.get(req.id)!.errorCode ?? null).toBeNull();
    expect(deps.store.runners.get(runner.id)).toMatchObject({ consecutiveFailures: 1, lastDeliveryAt: null });
  });
});

describe('a transient key-service failure (KMS config lookup or KMS unreachable) is not an unreadable key', () => {
  it('signing answers RUNNERS_UNAVAILABLE: the request stays queued, no unreadable gauge, no operator notice; a real decrypt failure is still UNREADABLE', async () => {
    const { RunnerKeyServiceUnavailableError } = await import('@pipeline-builder/api-core/pipeline-runners');
    const { generateOrgKey } = await import('../../src/runners/keys.js');
    const { keyedDeps } = await import('../helpers/key-fakes.js');
    const deps = keyedDeps();
    await generateOrgKey(deps, ORG, { userId: 'u' });
    deps.notified.length = 0;
    const realDecrypt = deps.secrets.decrypt;
    deps.secrets.decrypt = async () => { throw new RunnerKeyServiceUnavailableError('kms_config', 'KMS config lookup failed (HTTP 503)'); };
    deps.keyCaches.signers.clear();
    await expect(deps.signerFor(ORG)).rejects.toMatchObject({ code: 'RUNNERS_UNAVAILABLE', status: 409 });
    const { req } = await queuedStart(deps);
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'queued', lastDeliveryError: 'RUNNERS_UNAVAILABLE' });
    expect(deps.store.requests.get(req.id)!.errorCode ?? null).toBeNull();
    expect(deps.keyCaches.unreadable.size).toBe(0);
    expect(deps.gaugeValues.get('pipeline_runner_signing_keys_unreadable')).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(deps.notified).toEqual([]);
    // The service is back: the same key signs again.
    deps.secrets.decrypt = realDecrypt;
    deps.keyCaches.signers.clear();
    await expect(deps.signerFor(ORG)).resolves.toBeDefined();
    // A real decrypt failure of the ciphertext is UNREADABLE (gauge + notice).
    deps.secrets.unreadable.add(ORG);
    deps.keyCaches.signers.clear();
    await expect(deps.signerFor(ORG)).rejects.toMatchObject({ code: 'RUNNER_KEY_UNREADABLE' });
    expect(deps.keyCaches.unreadable.has(ORG)).toBe(true);
  });

  it('a key write whose encryption hits the transient failure answers RUNNERS_UNAVAILABLE, not RUNNER_KEY_UNREADABLE', async () => {
    const { RunnerKeyServiceUnavailableError } = await import('@pipeline-builder/api-core/pipeline-runners');
    const { generateOrgKey } = await import('../../src/runners/keys.js');
    const { keyedDeps } = await import('../helpers/key-fakes.js');
    const deps = keyedDeps();
    deps.secrets.encrypt = async () => { throw new RunnerKeyServiceUnavailableError('kms', 'KMS throttled'); };
    await expect(generateOrgKey(deps, ORG, { userId: 'u' })).rejects.toMatchObject({ code: 'RUNNERS_UNAVAILABLE', status: 409 });
    expect(deps.keyCaches.unreadable.size).toBe(0);
  });
});

describe('a key-service outage is RUNNERS_UNAVAILABLE with reason key_service, never "paused"', () => {
  const KEY_SERVICE_MESSAGE = "Runs can't be signed right now because the key service is unreachable. Queued runs retry automatically.";

  async function kmsDownDeps() {
    const { RunnerKeyServiceUnavailableError } = await import('@pipeline-builder/api-core/pipeline-runners');
    const { generateOrgKey } = await import('../../src/runners/keys.js');
    const { keyedDeps } = await import('../helpers/key-fakes.js');
    const deps = keyedDeps();
    await generateOrgKey(deps, ORG, { userId: 'u' });
    deps.secrets.decrypt = async () => { throw new RunnerKeyServiceUnavailableError('kms_config', 'KMS config lookup failed (HTTP 503)'); };
    deps.keyCaches.signers.clear();
    return deps;
  }

  it('signing: the refusal carries the key-service message and details.reason', async () => {
    const deps = await kmsDownDeps();
    await expect(deps.signerFor(ORG)).rejects.toMatchObject({ code: 'RUNNERS_UNAVAILABLE', status: 409, message: KEY_SERVICE_MESSAGE, details: { reason: 'key_service' } });
  });

  it('delivery: the verdict says key_service and the request stays queued', async () => {
    const { deliverPush } = await import('../../src/runners/delivery.js');
    const deps = await kmsDownDeps();
    const { runner, req } = await queuedStart(deps);
    const verdict = await deliverPush(deps, runner, { runnerId: runner.id, requestId: req.id, action: 'start', pipelineId: PIPE, requestedBy: 'u', expiresAt: req.expiresAt });
    expect(verdict).toEqual({ kind: 'fail', code: 'RUNNERS_UNAVAILABLE', reason: 'key_service' });
    deps.keyCaches.signers.clear();
    expect(await processDelivery(deps, req.id)).toEqual({ done: true });
    expect(deps.store.requests.get(req.id)).toMatchObject({ status: 'queued', lastDeliveryError: 'RUNNERS_UNAVAILABLE' });
    expect(deps.keyCaches.unreadable.size).toBe(0);
  });

  it('discovery: answers the key-service message with details.reason key_service', async () => {
    const deps = await kmsDownDeps();
    deps.store.runners.set('r', runnerRow({ id: 'r', label: 'a' }));
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null, linkStatus: 'unlinked' });
    const err = await routeExecution({ pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' }, deps).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'RUNNERS_UNAVAILABLE', status: 409, message: KEY_SERVICE_MESSAGE, details: { reason: 'key_service' } });
    expect(deps.store.registry.get(PIPE)!.linkStatus).toBe('unlinked');
  });

  it('discovery: a real operator pause still answers paused', async () => {
    const { RUNNERS_UNAVAILABLE_MESSAGES } = await import('../../src/runners/routing.js');
    const deps = testDeps({ deliveriesPaused: async () => true });
    deps.store.runners.set('r', runnerRow({ id: 'r', label: 'a' }));
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null, linkStatus: 'unlinked' });
    const err = await routeExecution({ pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' }, deps).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'RUNNERS_UNAVAILABLE', message: RUNNERS_UNAVAILABLE_MESSAGES.paused, details: { reason: 'paused' } });
  });
});

describe('discovery with an unusable key', () => {
  it('answers 409 RUNNER_KEY_MISSING, not 404 PIPELINE_NOT_FOUND_IN_RUNNERS, and keeps the registry row as it was', async () => {
    const deps = testDeps();
    deps.store.runners.set('r', runnerRow({ id: 'r', label: 'a' }));
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: null, linkStatus: 'unlinked' });
    deps.signerFor = keyError('RUNNER_KEY_MISSING');
    const err = await routeExecution({ pipelineId: PIPE, orgId: ORG, requestedBy: 'user-1', action: 'start' }, deps).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'RUNNER_KEY_MISSING', status: 409 });
    expect(deps.store.registry.get(PIPE)!.linkStatus).toBe('unlinked');
  });
});

describe('probeRunnerLink', () => {
  it('an unexpected failure (the org hierarchy unavailable) never leaves the row `checking`', async () => {
    const deps = testDeps();
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: 'old', linkStatus: 'checking' });
    deps.hierarchy.ancestors = async () => { throw new Error('platform down'); };
    expect(await probeRunnerLink(deps, { pipelineId: PIPE, orgId: ORG, requestedBy: 'u' })).toBe('not_found');
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: 'old', linkStatus: 'linked' });
  });
});

describe('stale `checking` rows', () => {
  it('the sweep puts back a row left `checking` for over 5 minutes (a replica died mid-probe); a fresh one is left alone', async () => {
    const { runSweep } = await import('../../src/runners/lifecycle.js');
    const deps = testDeps();
    const FRESH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    deps.store.registry.set(PIPE, { orgId: ORG, pipelineName: 'p', region: null, runnerId: 'r-old', linkStatus: 'checking', linkCheckedAt: new Date(deps.clock.t - 6 * 60_000) });
    deps.store.registry.set('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { orgId: ORG, pipelineName: 'q', region: null, runnerId: null, linkStatus: 'checking', linkCheckedAt: new Date(deps.clock.t - 10 * 60_000) });
    deps.store.registry.set(FRESH, { orgId: ORG, pipelineName: 'f', region: null, runnerId: null, linkStatus: 'checking', linkCheckedAt: new Date(deps.clock.t - 60_000) });
    await runSweep(deps);
    expect(deps.store.registry.get(PIPE)!.linkStatus).toBe('linked');
    expect(deps.store.registry.get('dddddddd-dddd-4ddd-8ddd-dddddddddddd')!.linkStatus).toBe('unlinked');
    expect(deps.store.registry.get(FRESH)!.linkStatus).toBe('checking');
  });
});

describe('runnerLinkDto', () => {
  it('an inherited runner whose owner name cannot be read is still named (by org id), never read as the caller\'s own', async () => {
    const { runnerLinkDto } = await import('../../src/routes/runner-link-routes.js');
    const deps = testDeps();
    const PARENT_ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    deps.store.runners.set('r', runnerRow({ id: 'r', orgId: PARENT_ORG }));
    deps.hierarchy.names = async () => ({});
    const dto = await runnerLinkDto(deps, PIPE, ORG, { pipelineName: 'p', region: null, runnerId: 'r', linkStatus: 'linked' });
    expect(dto.runner?.ownerOrgName).toBe(PARENT_ORG);
    expect(dto.runner?.isOwn).toBe(false);
    // Own: compared case-insensitively (org ids are lowercase hex, a caller's may not be).
    deps.store.runners.set('o', runnerRow({ id: 'o', orgId: ORG }));
    const own = await runnerLinkDto(deps, PIPE, ORG.toUpperCase(), { pipelineName: 'p', region: null, runnerId: 'o', linkStatus: 'linked' });
    expect(own.runner).toMatchObject({ isOwn: true, ownerOrgName: null });
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Delete plugin" as a background job (services/plugin-delete-jobs.ts): the
 * start resolves once the delete is ACCEPTED (before its long wait), the job
 * records running → succeeded / failed in Redis under the org, a refusal
 * before acceptance rejects the start and leaves no job, and a job whose
 * replica stopped heartbeating reads as failed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const store = new Map<string, { value: string; ex: number }>();
const fakeRedis = {
  set: jest.fn<AnyFn>(async (key: string, value: string, _ex: string, ttl: number) => { store.set(key, { value, ex: ttl }); return 'OK'; }),
  get: jest.fn<AnyFn>(async (key: string) => store.get(key)?.value ?? null),
};
jest.unstable_mockModule('../src/queue/connections.js', () => ({ getConnectionForDb: () => fakeRedis }));

/** The real delete's shape: refusals, then onAccepted, then the long work. */
let release: () => void = () => undefined;
let refuseWith: Error | null = null;
let failAfterAccept: Error | null = null;
const mockDeleteByName = jest.fn<AnyFn>(async (_name: string, _caller: unknown, opts: { batchId: string; onAccepted: () => Promise<void> }) => {
  if (refuseWith) throw refuseWith;
  const gate = new Promise<void>((r) => { release = r; });
  await opts.onAccepted();
  await gate;
  if (failAfterAccept) throw failAfterAccept;
  return { batchId: opts.batchId, deleted: [{ id: 'p1', version: '1.0.0' }], skipped: [{ id: 'p2', version: '1.1.0', reason: 'in_use' }], cancelled: { builds: 1, remediations: 0 } };
});
jest.unstable_mockModule('../src/services/plugin-name-actions.js', () => ({ deleteByName: mockDeleteByName }));

const { AppError, ErrorCode } = await import('@pipeline-builder/api-core');
const jobs = await import('../src/services/plugin-delete-jobs.js');

const caller = { orgId: 'org-1', userId: 'u-1', parentOrgId: null, checkWrite: () => 'ok' as const, logWarn: jest.fn() };
const opts = { force: false, quotaService: {} as never };

beforeEach(() => {
  store.clear();
  refuseWith = null;
  failAfterAccept = null;
  jest.clearAllMocks();
});

describe('plugin delete jobs', () => {
  it('accepts before the long work, reads running, then succeeded with the deleted and skipped lists', async () => {
    const started = await jobs.startDeleteJob('lint', caller as never, opts);
    expect(started.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockDeleteByName).toHaveBeenCalledWith('lint', caller, expect.objectContaining({ batchId: started.batchId, force: false }));
    expect(store.get(jobs.deleteJobKey('org-1', started.jobId))!.ex).toBe(jobs.DELETE_JOB_TTL_SECONDS);

    const running = await jobs.readDeleteJob('org-1', 'lint', started.jobId);
    expect(running).toEqual(expect.objectContaining({ state: 'running', batchId: started.batchId, deleted: [], skipped: [], finishedAt: null }));
    expect(running).not.toHaveProperty('heartbeatAt');

    release();
    await started.done;
    const finished = await jobs.readDeleteJob('org-1', 'lint', started.jobId);
    expect(finished).toEqual(expect.objectContaining({
      state: 'succeeded',
      batchId: started.batchId,
      error: null,
      deleted: [{ id: 'p1', version: '1.0.0' }],
      skipped: [{ id: 'p2', version: '1.1.0', reason: 'in_use' }],
    }));
    expect(finished!.finishedAt).not.toBeNull();
  });

  it('a job is the org\'s and the name\'s only', async () => {
    const started = await jobs.startDeleteJob('lint', caller as never, opts);
    release();
    await started.done;
    expect(await jobs.readDeleteJob('org-2', 'lint', started.jobId)).toBeNull();
    expect(await jobs.readDeleteJob('org-1', 'other', started.jobId)).toBeNull();
    expect(await jobs.readDeleteJob('org-1', 'lint', '0190c0de-0000-7000-8000-0000000000ff')).toBeNull();
    store.set(jobs.deleteJobKey('org-1', 'junk'), { value: '{not json', ex: 1 });
    expect(await jobs.readDeleteJob('org-1', 'lint', 'junk')).toBeNull();
  });

  it('a refusal before acceptance rejects the start and leaves no job', async () => {
    refuseWith = new AppError(409, ErrorCode.PLUGIN_NAME_LOCKED, 'locked');
    await expect(jobs.startDeleteJob('lint', caller as never, opts)).rejects.toThrow('locked');
    expect(store.size).toBe(0);
  });

  it('a status write that fails at acceptance refuses the delete', async () => {
    fakeRedis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(jobs.startDeleteJob('lint', caller as never, opts)).rejects.toThrow('redis down');
  });

  it('a failure after acceptance is recorded as the job\'s failed state, with its code', async () => {
    failAfterAccept = new AppError(500, ErrorCode.INTERNAL_ERROR, 'db gone');
    const started = await jobs.startDeleteJob('lint', caller as never, opts);
    release();
    await started.done;
    expect(await jobs.readDeleteJob('org-1', 'lint', started.jobId)).toEqual(expect.objectContaining({
      state: 'failed', error: { code: 'INTERNAL_ERROR', message: 'db gone' },
    }));
  });

  it('a lost final write is retried once', async () => {
    const started = await jobs.startDeleteJob('lint', caller as never, opts);
    fakeRedis.set.mockRejectedValueOnce(new Error('blip'));
    release();
    await started.done;
    expect((await jobs.readDeleteJob('org-1', 'lint', started.jobId))!.state).toBe('succeeded');
  });

  it('a running job whose heartbeat went stale reads as failed', async () => {
    const started = await jobs.startDeleteJob('lint', caller as never, opts);
    const later = new Date(Date.now() + jobs.DELETE_JOB_STALE_MS + 1_000);
    expect(await jobs.readDeleteJob('org-1', 'lint', started.jobId, later)).toEqual(expect.objectContaining({ state: 'failed', error: expect.objectContaining({ code: null }) }));
    release();
    await started.done;
  });
});

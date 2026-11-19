// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * dismissFailedJob — what dismissing a failed build hands back.
 *
 * A dismissed job is gone for good, so it must release what it still holds
 * (its quota slot, via the idempotent releasePluginQuota, and its staged build
 * context) — EXCEPT when the DLQ is already retrying the same build, whose
 * record owns those resources. It runs under the job's retry lock so a dismiss
 * and a retry cannot interleave.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';

const releasePluginQuota = jest.fn<AnyFn>();
const cleanupBuildArtifacts = jest.fn<AnyFn>();
const dlqGetJob = jest.fn<AnyFn>();
const locks: Array<[string, string, string]> = [];

jest.unstable_mockModule('../src/queue/build-quota.js', () => ({ releasePluginQuota, reserveReplaySlot: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/queue/build-workspace.js', () => ({ cleanupBuildArtifacts }));
jest.unstable_mockModule('../src/queue/connections.js', () => ({
  DLQ_NAME: 'plugin-build-dlq',
  dlqJobId: (q: string, id: string) => `${q}:${id}`,
  getDeadLetterQueue: () => ({ getJob: dlqGetJob }),
  getOrgTier: jest.fn<AnyFn>(),
  getTierQueue: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/queue/job-lock.js', () => ({
  withJobLock: async (kind: string, q: string, id: string, fn: () => Promise<unknown>) => { locks.push([kind, q, id]); return fn(); },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => stubModule('@pipeline-builder/api-core', {
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}));

const { dismissFailedJob } = await import('../src/queue/requeue.js');

const quota = {} as any;
function job(over: { failed?: boolean; data?: Record<string, unknown> } = {}) {
  return {
    id: '42',
    queueName: 'plugin-build-pro',
    data: { orgId: 'org-a', buildRequest: { contextDir: '/tmp/ctx-42', s3Key: 'ctx/42.zip' }, ...(over.data ?? {}) },
    isFailed: jest.fn<AnyFn>().mockResolvedValue(over.failed ?? true),
    remove: jest.fn<AnyFn>().mockResolvedValue(undefined),
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  locks.length = 0;
  dlqGetJob.mockResolvedValue(undefined);
});

describe('dismissFailedJob', () => {
  it('releases the quota slot and the build context, then removes the job — under the retry lock', async () => {
    const j = job();
    await expect(dismissFailedJob(j, quota)).resolves.toEqual({ contextReleased: true, retryingViaDlq: false });
    expect(locks).toEqual([['retry', 'plugin-build-pro', '42']]);
    expect(releasePluginQuota).toHaveBeenCalledWith(j, quota);
    expect(cleanupBuildArtifacts).toHaveBeenCalledWith({ contextDir: '/tmp/ctx-42', s3Key: 'ctx/42.zip' });
    expect(j.remove).toHaveBeenCalledTimes(1);
  });

  it('does not delete a context the failure path already cleaned', async () => {
    const j = job({ data: { contextCleaned: true } });
    await expect(dismissFailedJob(j, quota)).resolves.toEqual({ contextReleased: false, retryingViaDlq: false });
    expect(cleanupBuildArtifacts).not.toHaveBeenCalled();
    expect(releasePluginQuota).toHaveBeenCalled(); // idempotent: a settled job refunds nothing
    expect(j.remove).toHaveBeenCalled();
  });

  it('a lingering entry whose DLQ twin is retrying the build: only the entry goes', async () => {
    dlqGetJob.mockResolvedValue({ id: 'plugin-build-pro:42' });
    const j = job();
    await expect(dismissFailedJob(j, quota)).resolves.toEqual({ contextReleased: false, retryingViaDlq: true });
    expect(dlqGetJob).toHaveBeenCalledWith('plugin-build-pro:42');
    expect(releasePluginQuota).not.toHaveBeenCalled();
    expect(cleanupBuildArtifacts).not.toHaveBeenCalled();
    expect(j.remove).toHaveBeenCalled();
  });

  it('a job no longer failed (a concurrent retry took it) is left alone → null', async () => {
    const j = job({ failed: false });
    await expect(dismissFailedJob(j, quota)).resolves.toBeNull();
    expect(j.remove).not.toHaveBeenCalled();
    expect(releasePluginQuota).not.toHaveBeenCalled();
    expect(cleanupBuildArtifacts).not.toHaveBeenCalled();
  });
});

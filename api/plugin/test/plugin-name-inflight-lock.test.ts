// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-name lock (helpers/plugin-name-lock.ts) against an in-memory Redis,
 * the in-flight build / remediation scan of a name (queue/name-inflight.ts)
 * against fake queues, and the build success tail's lock refusal and source
 * keeping (services/version-persist.ts).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

// -- in-memory Redis ------------------------------------------------------------
const kv = new Map<string, string>();
const redis = {
  set: jest.fn(async (k: string, v: string, _px: string, _ms: number, nx: string) => {
    if (nx === 'NX' && kv.has(k)) return null;
    kv.set(k, v);
    return 'OK';
  }),
  exists: jest.fn(async (k: string) => (kv.has(k) ? 1 : 0)),
  eval: jest.fn(async (lua: string, _n: number, k: string, token: string) => {
    if (kv.get(k) !== token) return 0;
    if (lua.includes("'del'")) kv.delete(k);
    return 1;
  }),
};

// -- fake queues ------------------------------------------------------------------
type FakeJob = { id: string; name: string; data: any; state: string; remove: AnyFn };
let jobs: FakeJob[] = [];
const fakeQueue = (queue: string) => ({
  getJobs: async (types: string[]) => jobs.filter((j) => j.data.__queue === queue && types.includes(j.state)),
});
const job = (id: string, state: string, data: Record<string, unknown>, name = 'build', queue = 'tier'): FakeJob => {
  const j: FakeJob = { id, name, state, data: { ...data, __queue: queue }, remove: jest.fn(async () => { jobs = jobs.filter((x) => x !== j); }) };
  return j;
};
let redisDown = false;
jest.unstable_mockModule('../src/queue/connections.js', () => ({
  getConnectionForDb: () => {
    if (redisDown) return { exists: async () => { throw new Error('ECONNREFUSED'); } };
    return redis;
  },
  getAllTierQueues: () => [{ tier: 'developer', queue: fakeQueue('tier') }],
  getDeadLetterQueue: () => fakeQueue('dlq'),
}));
const mockRelease = jest.fn();
const mockCleanup = jest.fn();
jest.unstable_mockModule('../src/queue/build-quota.js', () => ({ releasePluginQuota: mockRelease }));
jest.unstable_mockModule('../src/queue/build-workspace.js', () => ({ cleanupBuildArtifacts: mockCleanup }));

// -- version-persist's collaborators -----------------------------------------------
const mockDeploy = jest.fn<AnyFn>(async (row: any) => ({ id: 'p-1', name: row.name, version: row.version }));
const mockKeep = jest.fn<AnyFn>(async () => null);
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService: { deployVersion: mockDeploy } }));
jest.unstable_mockModule('../src/services/plugin-sources.js', () => ({ keepVersionSource: mockKeep }));
jest.unstable_mockModule('../src/services/kept-setup-images.js', () => ({ supersedeKeptSetupImages: jest.fn() }));
jest.unstable_mockModule('../src/helpers/plugin-helpers.js', () => ({ toPluginInsert: (r: unknown) => r }));

const lock = await import('../src/helpers/plugin-name-lock.js');
const inflight = await import('../src/queue/name-inflight.js');
const { persistVersion } = await import('../src/services/version-persist.js');

beforeEach(() => {
  jest.clearAllMocks();
  kv.clear();
  jobs = [];
  redisDown = false;
});

describe('plugin name lock', () => {
  it('holds the name for fn, refuses a second holder with 409 PLUGIN_NAME_LOCKED, and releases after', async () => {
    let inner: unknown;
    await lock.withPluginNameLock('ORG', 'lint', async () => {
      expect(await lock.isPluginNameLocked('org', 'lint')).toBe(true);
      inner = await lock.withPluginNameLock('org', 'lint', async () => 'never').catch((e) => e);
    });
    expect(inner).toMatchObject({ statusCode: 409, code: 'PLUGIN_NAME_LOCKED' });
    expect(await lock.isPluginNameLocked('org', 'lint')).toBe(false);
    expect(await lock.isPluginNameLocked('org', 'other')).toBe(false);
  });

  it('releases even when fn throws, and never drops a lock someone else re-took', async () => {
    await expect(lock.withPluginNameLock('org', 'lint', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(kv.size).toBe(0);
    await lock.withPluginNameLock('org', 'lint', async () => { kv.set(lock.pluginNameLockKey('org', 'lint'), 'someone-else'); });
    expect(kv.get(lock.pluginNameLockKey('org', 'lint'))).toBe('someone-else');
  });

  it('assertPluginNameUnlocked refuses terminally (BullMQ reads the name) while locked; an unreadable lock fails open', async () => {
    kv.set(lock.pluginNameLockKey('org', 'lint'), 't');
    await expect(lock.assertPluginNameUnlocked('org', 'lint')).rejects.toMatchObject({ name: 'UnrecoverableError', code: 'PLUGIN_NAME_LOCKED', statusCode: 409 });
    redisDown = true;
    await expect(lock.assertPluginNameUnlocked('org', 'lint')).resolves.toBeUndefined();
  });
});

describe('in-flight builds and remediations of a name', () => {
  const build = (id: string, state: string, name = 'lint', orgId = 'org-1', queue = 'tier') =>
    job(id, state, { orgId, pluginRecord: { name }, buildRequest: { contextDir: `/tmp/${id}`, s3Key: `${id}.zip` } }, `${name}:1.0.0`, queue);
  const remediation = (id: string, state: string) => job(id, state, { kind: 'plugin-remediation', orgId: 'org-1', pluginName: 'lint' }, 'plugin-remediation');

  it('counts only the name\'s jobs in the org, builds and remediations apart', async () => {
    jobs = [build('1', 'waiting'), build('2', 'active'), build('3', 'waiting', 'fmt'), build('4', 'waiting', 'lint', 'org-2'), remediation('5', 'delayed'), build('6', 'waiting', 'lint', 'org-1', 'dlq')];
    expect(await inflight.countInFlight('ORG-1', 'lint')).toEqual({ builds: 3, remediations: 1 });
  });

  it('cancels queued ones (tier queues and DLQ), releasing a build\'s slot and staged context; running ones stay', async () => {
    jobs = [build('1', 'waiting'), build('2', 'active'), remediation('5', 'prioritized'), build('6', 'delayed', 'lint', 'org-1', 'dlq'), build('3', 'waiting', 'fmt')];
    expect(await inflight.cancelQueued('org-1', 'lint', {} as never)).toEqual({ builds: 2, remediations: 1 });
    expect(jobs.map((j) => j.id).sort()).toEqual(['2', '3']);
    expect(mockRelease).toHaveBeenCalledTimes(2);
    expect(mockCleanup).toHaveBeenCalledWith({ contextDir: '/tmp/1', s3Key: '1.zip' });
  });

  it('waits for running ones, and gives up after the wait (the store then refuses them)', async () => {
    const running = build('2', 'active');
    jobs = [running];
    setTimeout(() => { running.state = 'completed'; }, 15);
    expect(await inflight.waitForRunning('org-1', 'lint', 1_000, 5)).toBe(0);
    jobs = [build('7', 'active')];
    expect(await inflight.waitForRunning('org-1', 'lint', 20, 5)).toBe(1);
  });
});

describe('persistVersion — the build success tail', () => {
  const input = (buildType: string, stagingKey: string | null = 'org-1/req.zip') => ({
    orgId: 'org-1',
    userId: 'u-1',
    access: { isSystemAdmin: false, canPublish: false },
    pluginRecord: { name: 'lint', version: '1.0.0', buildType } as any,
    image: { imageDigest: `sha256:${'a'.repeat(64)}`, imageSource: 'build' as any },
    facts: null,
    summary: null,
    skippedScan: false,
    emit: jest.fn(),
    stagingKey,
  });

  it('keeps a ZIP-built version\'s source BEFORE anything else follows the store', async () => {
    const onStored = jest.fn<AnyFn>();
    await persistVersion({ ...input('build_image'), onStored });
    expect(mockKeep).toHaveBeenCalledWith({ orgId: 'org-1', pluginId: 'p-1', version: '1.0.0', stagingKey: 'org-1/req.zip' });
    expect(mockKeep.mock.invocationCallOrder[0]!).toBeLessThan(onStored.mock.invocationCallOrder[0]!);
  });

  it('a prebuilt-image upload keeps no source (source_kind none)', async () => {
    await persistVersion(input('prebuilt'));
    expect(mockKeep).toHaveBeenCalledWith(expect.objectContaining({ stagingKey: null }));
  });

  it('refuses to store while a by-name delete holds the name — no version lands after it', async () => {
    kv.set(lock.pluginNameLockKey('org-1', 'lint'), 'delete');
    await expect(persistVersion(input('build_image'))).rejects.toMatchObject({ code: 'PLUGIN_NAME_LOCKED', name: 'UnrecoverableError' });
    expect(mockDeploy).not.toHaveBeenCalled();
    expect(mockKeep).not.toHaveBeenCalled();
  });
});

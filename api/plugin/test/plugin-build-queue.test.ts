// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/plugin-build-queue.
 *
 * Mocks BullMQ (Queue, Worker), ioredis, fs, and all external
 * services (SSEManager, QuotaService, db, buildAndPush).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock state  must be hoisted before imports

const mockQueueAdd = jest.fn<(...args: any[]) => any>();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockQueueGetJob = jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined);
const mockQueueGetJobs = jest.fn().mockResolvedValue([]);
const mockQueueGetJobCounts = jest.fn().mockResolvedValue({});
const mockQueueObliterate = jest.fn().mockResolvedValue(undefined);
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
// Records every `new Worker(name, processor, opts)` call. Used by the
// idempotency test to verify a second startWorker() doesn't construct
// new workers. The bullmq mock returns plain classes (not jest.fn()),
// so `Worker.mock.calls` doesn't exist — this spy is the substitute.
const mockWorkerCtor = jest.fn();

// Track which worker processor is for which queue name
const capturedProcessors: Record<string, (job: any) => Promise<any>> = {};

const mockIncrementQuota = jest.fn();
// DLQ replay / failed-retry re-reserve a plugin slot; default to capacity
// available. Hoisted so individual tests can override (e.g. org-at-cap).
const mockReserveQuota = jest.fn<(...args: any[]) => any>(() =>
  Promise.resolve({ exceeded: false, quota: { type: 'plugins', limit: 100, used: 1, remaining: 99 } }));
const mockExistsSync = jest.fn<(...args: any[]) => any>().mockReturnValue(false);
const mockRmSync = jest.fn();
const mockUtimesSync = jest.fn();

const mockBuildAndPush = jest.fn<(...args: any[]) => any>();

const mockDeployVersion = jest.fn<(...args: any[]) => any>();

const mockPipelineCoreConfig: Record<string, any> = {
  pluginBuild: {
    concurrency: 1,
    maxAttempts: 2,
    backoffDelayMs: 5000,
    workerTimeoutMs: 10000,
    tempDirMaxAgeMs: 14400000,
    dlqMaxAttempts: 3,
    dlqBackoffBaseMs: 300000,
    dlqMaxSize: 20,
  },
  redis: { host: 'localhost', port: 6379 },
};

// Registers every ESM module mock the SUT graph consumes. Called once at
// load time and re-invoked after each `jest.resetModules()` (resetModules
// clears unstable_mockModule registrations along with the module registry).
function registerMocks() {
  jest.unstable_mockModule('bullmq', () => {
    class MockQueue {
      add = mockQueueAdd;
      close = mockQueueClose;
      getJob = mockQueueGetJob;
      getJobs = mockQueueGetJobs;
      getJobCounts = mockQueueGetJobCounts;
      obliterate = mockQueueObliterate;
      name: string;
      constructor(name: string, _opts: any) {
        this.name = name;
      }
    }
    class MockWorker {
      on = mockWorkerOn;
      close = mockWorkerClose;
      constructor(name: string, processor: (job: any) => Promise<any>, _opts: any) {
        mockWorkerCtor(name);
        capturedProcessors[name] = processor;
      }
    }
    return { Queue: MockQueue, Worker: MockWorker };
  });

  jest.unstable_mockModule('ioredis', () => {
    class MockRedis {
      status = 'ready';
      disconnect = jest.fn();
      on = jest.fn();
      eval = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
      incr = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
      decr = jest.fn<(...args: any[]) => any>().mockResolvedValue(0);
      expire = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
      set = jest.fn<(...args: any[]) => any>().mockResolvedValue('OK');
      hset = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
      hdel = jest.fn<(...args: any[]) => any>().mockResolvedValue(1);
      hgetall = jest.fn<(...args: any[]) => any>().mockResolvedValue({});
    }
    // Source imports the named `{ Redis }`; expose it alongside default.
    return { __esModule: true, default: MockRedis, Redis: MockRedis };
  });

  jest.unstable_mockModule('fs', () => ({
    existsSync: mockExistsSync,
    rmSync: mockRmSync,
    utimesSync: mockUtimesSync,
    readdirSync: jest.fn().mockReturnValue([]),
  }));

  jest.unstable_mockModule('../src/helpers/docker-build.js', () => ({
    buildAndPush: mockBuildAndPush,
    loadAndPush: jest.fn(),
    BUILD_TEMP_ROOT: '/tmp',
    getBuildkitAddrForTier: jest.fn(() => 'tcp://buildkitd:1234'),
  }));

  jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
    pluginService: { deployVersion: mockDeployVersion },
  }));

  jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
    CoreConstants: {
      PLUGIN_BUILD_COMPLETED_RETENTION_SECS: 86400,
      PLUGIN_BUILD_FAILED_RETENTION_SECS: 604800,
      PLUGIN_BUILD_QUEUE_NAME: 'plugin-build',
    },
    Config: { get: (section: string) => mockPipelineCoreConfig[section] ?? {}, getAny: (section: string) => mockPipelineCoreConfig[section] ?? {} },
    db: { execute: jest.fn(), insert: jest.fn(), select: jest.fn(), update: jest.fn() },
    schema: { plugin: {} },
    reportingService: { record: jest.fn(), invalidateOrg: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined) },
    runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    withTenantTx: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      insert: () => ({ values: () => Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() }) }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    }),
  }));
  jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
    CoreConstants: {
      PLUGIN_BUILD_COMPLETED_RETENTION_SECS: 86400,
      PLUGIN_BUILD_FAILED_RETENTION_SECS: 604800,
      PLUGIN_BUILD_QUEUE_NAME: 'plugin-build',
    },
    Config: { get: (section: string) => mockPipelineCoreConfig[section] ?? {}, getAny: (section: string) => mockPipelineCoreConfig[section] ?? {} },
    db: { execute: jest.fn(), insert: jest.fn(), select: jest.fn(), update: jest.fn() },
    schema: { plugin: {} },
    reportingService: { record: jest.fn(), invalidateOrg: jest.fn<(...args: any[]) => any>().mockResolvedValue(undefined) },
    runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    withTenantTx: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
      insert: () => ({ values: () => Object.assign(Promise.resolve(), { onConflictDoNothing: () => Promise.resolve() }) }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    }),
  }));;

  jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
    extractDbError: jest.fn(() => ({})),
    incrementQuota: mockIncrementQuota,
    decrementQuota: mockIncrementQuota,
    // DLQ replay / failed-retry re-reserves a plugin slot; default to capacity available.
    reserveQuota: mockReserveQuota,
    getServiceAuthHeader: () => 'Bearer test-service-token',
    createRemoteAuditClient: () => ({ record: jest.fn() }),
    VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
    DEFAULT_TIER: 'developer',
  }));

  jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
    incCounter: jest.fn(),
    observe: jest.fn(),
    setGauge: jest.fn(),
  }));
}

registerMocks();

// Import after mocks

import type { PluginBuildJobData } from '../src/helpers/plugin-helpers.js';

// Helpers

function makeSseManager() {
  return { send: jest.fn() } as any;
}

function makeQuotaService() {
  return {
    increment: jest.fn().mockResolvedValue(undefined),
    // worker calls getOrgTier before buildAndPush to pick the
    // per-tier buildkitd address. Stub returns the default tier so the
    // build path falls back to the in-pod sidecar address.
    getTier: jest.fn().mockResolvedValue('developer'),
  } as any;
}

function makeJobData(overrides: Partial<PluginBuildJobData> = {}): PluginBuildJobData {
  return {
    requestId: 'req-123',
    orgId: 'org-1',
    userId: 'user-1',
    buildRequest: {
      contextDir: '/tmp/build-ctx',
      dockerfile: 'Dockerfile',
      name: 'my-plugin',
      version: '1.0.0',
      orgId: 'org-1',
      buildType: 'build_image',
      registry: { host: 'registry', port: 5000, network: '', http: true },
    },
    pluginRecord: {
      orgId: 'org-1',
      name: 'my-plugin',
      description: 'Test plugin',
      version: '1.0.0',
      metadata: {},
      pluginType: 'CodeBuildStep',
      computeType: 'SMALL',
      primaryOutputDirectory: null,
      dockerfile: 'Dockerfile',
      env: {},
      buildArgs: {},
      keywords: ['test'],
      installCommands: [],
      commands: ['echo hello'],

      accessModifier: 'private',
      timeout: null,
      failureBehavior: 'fail',
      secrets: [],
      category: 'unknown',
      buildType: 'build_image',
    },
    ...overrides,
  };
}

function makeJob(data: PluginBuildJobData, overrides: Record<string, any> = {}) {
  return {
    id: 'job-1',
    data,
    attemptsMade: 1,
    opts: { attempts: 2 },
    ...overrides,
  };
}

function getMainProcessor() {
  return capturedProcessors['plugin-build-developer'];
}

// Tests

describe('plugin-build-queue', () => {
  let queueModule: typeof import('../src/queue/plugin-build-queue.js');

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.keys(capturedProcessors).forEach((k) => delete capturedProcessors[k]);
    mockExistsSync.mockReturnValue(false);

    jest.resetModules();

    // Re-apply mocks after resetModules (it clears the registry + mocks).
    registerMocks();

    queueModule = await import('../src/queue/plugin-build-queue.js');
  });

  describe('getTierQueue()', () => {
    it('returns a BullMQ Queue instance for the default tier', () => {
      const q = queueModule.getTierQueue('developer');
      expect(q).toBeDefined();
      expect(q.add).toBeDefined();
    });

    it('returns the same instance on subsequent calls (per-tier singleton)', () => {
      const q1 = queueModule.getTierQueue('developer');
      const q2 = queueModule.getTierQueue('developer');
      expect(q1).toBe(q2);
    });

    it('returns distinct instances for distinct tiers', () => {
      const dev = queueModule.getTierQueue('developer');
      const pro = queueModule.getTierQueue('pro');
      expect(dev).not.toBe(pro);
    });
  });

  describe('startWorker()', () => {
    it('creates main and DLQ workers', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);
      expect(getMainProcessor()).toBeInstanceOf(Function);
      expect(capturedProcessors['plugin-build-dlq']).toBeInstanceOf(Function);
    });

    it('is idempotent — repeat calls are no-ops when workers exist', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);
      // Capture the Worker-constructor call count after the first start,
      // then re-invoke and assert no new workers were constructed. The
      // mock Worker is a plain class (no `.mock` property), so we read
      // from the module-level `mockWorkerCtor` spy that records every
      // `new Worker(name, ...)` call from inside the mock constructor.
      const beforeWorkerCtorCalls = mockWorkerCtor.mock.calls.length;
      expect(beforeWorkerCtorCalls).toBeGreaterThan(0);
      queueModule.startWorker(sse, quota);
      const afterWorkerCtorCalls = mockWorkerCtor.mock.calls.length;
      expect(afterWorkerCtorCalls).toBe(beforeWorkerCtorCalls);
    });

    it('registers failed and error event handlers', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const events = mockWorkerOn.mock.calls.map((c: any) => c[0]);
      expect(events).toContain('failed');
      expect(events).toContain('error');
    });
  });

  describe('worker processor', () => {
    it('calls buildAndPush, persists to DB, and sends SSE events', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const insertedPlugin = { id: 'plugin-1', name: 'my-plugin', version: '1.0.0' };
      mockBuildAndPush.mockResolvedValue({ fullImage: 'registry:5000/plugin:p-test-abc123' });
      mockDeployVersion.mockResolvedValue(insertedPlugin);

      const jobData = makeJobData();
      const job = makeJob(jobData);

      const result = await getMainProcessor()(job);

      // added a second arg with the per-tier buildkitd address.
      expect(mockBuildAndPush).toHaveBeenCalledWith(jobData.buildRequest, expect.objectContaining({ buildkitAddr: expect.any(String) }));
      expect(mockDeployVersion).toHaveBeenCalledWith(jobData.pluginRecord, 'user-1');

      expect(sse.send).toHaveBeenCalledWith('req-123', 'INFO', 'Build started', expect.any(Object));
      expect(sse.send).toHaveBeenCalledWith('req-123', 'INFO', 'Image pushed', expect.any(Object));
      expect(sse.send).toHaveBeenCalledWith('req-123', 'COMPLETED', 'Plugin deployed', expect.objectContaining({
        id: 'plugin-1',
        name: 'my-plugin',
      }));

      // quota is reserved at upload time by the route handler;
      // the worker no longer increments on success (it only decrements on
      // permanent failure to roll back). Success path → no quota mutation.
      expect(mockIncrementQuota).not.toHaveBeenCalled();
      expect(result).toEqual({ pluginId: 'plugin-1', fullImage: 'registry:5000/plugin:p-test-abc123' });
    });

    it('cleans up temp directory after success', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const insertedPlugin = { id: 'p1', name: 'test', version: '1.0.0' };
      mockBuildAndPush.mockResolvedValue({ fullImage: 'img' });
      mockDeployVersion.mockResolvedValue(insertedPlugin);
      mockExistsSync.mockReturnValue(true);

      await getMainProcessor()(makeJob(makeJobData()));

      expect(mockRmSync).toHaveBeenCalledWith('/tmp/build-ctx', { recursive: true, force: true });
    });

    it('does not clean up temp directory on failure (deferred to failed handler)', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      mockBuildAndPush.mockRejectedValue(new Error('Docker build failed'));
      mockExistsSync.mockReturnValue(true);

      await expect(getMainProcessor()(makeJob(makeJobData()))).rejects.toThrow('Docker build failed');

      // Cleanup is handled by the 'failed' event handler, not the processor
      expect(mockRmSync).not.toHaveBeenCalled();
    });

    it('does not throw if temp dir cleanup fails on success', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const insertedPlugin = { id: 'p1', name: 'test', version: '1.0.0' };
      mockBuildAndPush.mockResolvedValue({ fullImage: 'img' });
      mockDeployVersion.mockResolvedValue(insertedPlugin);
      mockExistsSync.mockReturnValue(true);
      mockRmSync.mockImplementation(() => { throw new Error('permission denied'); });

      // Should not throw  cleanup error is caught internally
      const result = await getMainProcessor()(makeJob(makeJobData()));
      expect(result).toEqual({ pluginId: 'p1', fullImage: 'img' });
    });
  });

  describe('worker failed event handler', () => {
    it('sends SSE error event on job failure', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      // Find the 'failed' handler from the main worker (first registered)
      const failedCalls = mockWorkerOn.mock.calls.filter((c: any) => c[0] === 'failed');
      expect(failedCalls.length).toBeGreaterThan(0);
      const failedHandler = failedCalls[0][1];

      const jobData = makeJobData();
      const job = makeJob(jobData);
      const error = new Error('Build timeout');

      failedHandler(job, error);

      expect(sse.send).toHaveBeenCalledWith('req-123', 'ERROR', 'Build failed: an error occurred during the build process', expect.objectContaining({
        jobId: 'job-1',
        attemptsMade: 1,
        maxAttempts: 2,
      }));
    });

    it('handles null job gracefully', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const failedCalls = mockWorkerOn.mock.calls.filter((c: any) => c[0] === 'failed');
      const failedHandler = failedCalls[0][1];

      expect(() => failedHandler(null, new Error('Connection lost'))).not.toThrow();
      expect(sse.send).not.toHaveBeenCalled();
    });
  });

  describe('retryFailedJob() atomicity', () => {
    function makeFailedJob(overrides: Record<string, any> = {}) {
      return {
        id: 'failed-1',
        name: 'build-plugin',
        data: makeJobData(),
        isFailed: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
        remove: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it('releases the reserved slot and rethrows when add() throws (no orphan slot leak)', async () => {
      const quota = makeQuotaService();
      const failedJob = makeFailedJob();
      mockQueueGetJob.mockResolvedValue(failedJob);
      // Slot successfully reserved for the new job (quotaReleased === false).
      mockReserveQuota.mockResolvedValueOnce({ exceeded: false, quota: { type: 'plugins', limit: 100, used: 1, remaining: 99 } });
      mockQueueAdd.mockRejectedValueOnce(new Error('redis add failed'));

      await expect(queueModule.retryFailedJob('failed-1', quota)).rejects.toThrow('redis add failed');

      // decrementQuota (aliased to mockIncrementQuota) must release the reserved slot.
      expect(mockIncrementQuota).toHaveBeenCalledWith(
        quota, 'org-1', 'plugins', expect.any(String), expect.any(Function),
      );
      // The original failed entry must NOT be removed — the retry did not succeed.
      expect(failedJob.remove).not.toHaveBeenCalled();
    });

    it('does not decrement when add() throws and no slot was reserved (org at cap)', async () => {
      const quota = makeQuotaService();
      const failedJob = makeFailedJob();
      mockQueueGetJob.mockResolvedValue(failedJob);
      // Org already at cap → reserveReplaySlot returns quotaReleased = true (no slot handed over).
      mockReserveQuota.mockResolvedValueOnce({ exceeded: true, quota: { type: 'plugins', limit: 1, used: 1, remaining: 0 } });
      mockQueueAdd.mockRejectedValueOnce(new Error('redis add failed'));

      await expect(queueModule.retryFailedJob('failed-1', quota)).rejects.toThrow('redis add failed');

      // Nothing was reserved, so nothing must be released (no over-decrement).
      expect(mockIncrementQuota).not.toHaveBeenCalled();
      expect(failedJob.remove).not.toHaveBeenCalled();
    });

    it('remove() failure is non-fatal: the op still returns the new job id (no second enqueue on this op)', async () => {
      const quota = makeQuotaService();
      const failedJob = makeFailedJob({
        remove: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('remove failed')),
        // Re-check reports the job genuinely lingers in the failed set.
        isFailed: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      });
      mockQueueGetJob.mockResolvedValue(failedJob);
      mockQueueAdd.mockResolvedValueOnce({ id: 'new-job-1' });

      const newId = await queueModule.retryFailedJob('failed-1', quota);

      // Op succeeds (does NOT throw) — the build is already enqueued exactly once.
      expect(newId).toBe('new-job-1');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      // The lingering-entry branch was exercised (isFailed re-checked).
      expect(failedJob.isFailed).toHaveBeenCalled();
    });

    it('tolerates an already-removed original (idempotent) after add() succeeds', async () => {
      const quota = makeQuotaService();
      const failedJob = makeFailedJob({
        remove: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('job not in set')),
        // First call (findFailedJob locate) → true; post-remove re-check → false
        // (a concurrent remove already dropped it).
        isFailed: jest.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValue(false),
      });
      mockQueueGetJob.mockResolvedValue(failedJob);
      mockQueueAdd.mockResolvedValueOnce({ id: 'new-job-2' });

      const newId = await queueModule.retryFailedJob('failed-1', quota);

      expect(newId).toBe('new-job-2');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });

    it('happy path: enqueues once and removes the original failed entry', async () => {
      const quota = makeQuotaService();
      const failedJob = makeFailedJob();
      mockQueueGetJob.mockResolvedValue(failedJob);
      mockQueueAdd.mockResolvedValueOnce({ id: 'new-job-3' });

      const newId = await queueModule.retryFailedJob('failed-1', quota);

      expect(newId).toBe('new-job-3');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      // add() succeeded → no slot release.
      expect(mockIncrementQuota).not.toHaveBeenCalled();
    });

    it('returns null when no failed job with that id exists (no enqueue, no reserve)', async () => {
      const quota = makeQuotaService();
      mockQueueGetJob.mockResolvedValue(undefined);

      const result = await queueModule.retryFailedJob('missing', quota);

      expect(result).toBeNull();
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockReserveQuota).not.toHaveBeenCalled();
    });
  });

  describe('intFromEnv()', () => {
    afterEach(() => { delete process.env.PLUGIN_TEST_INT; });

    it('falls back to the default for a non-numeric env value', () => {
      process.env.PLUGIN_TEST_INT = 'not-a-number';
      expect(queueModule.intFromEnv('PLUGIN_TEST_INT', 42)).toBe(42);
    });

    it('falls back for unset, empty, zero, and negative values', () => {
      delete process.env.PLUGIN_TEST_INT;
      expect(queueModule.intFromEnv('PLUGIN_TEST_INT', 7)).toBe(7);
      process.env.PLUGIN_TEST_INT = '';
      expect(queueModule.intFromEnv('PLUGIN_TEST_INT', 7)).toBe(7);
      process.env.PLUGIN_TEST_INT = '0';
      expect(queueModule.intFromEnv('PLUGIN_TEST_INT', 7)).toBe(7);
      process.env.PLUGIN_TEST_INT = '-5';
      expect(queueModule.intFromEnv('PLUGIN_TEST_INT', 7)).toBe(7);
    });

    it('parses a valid positive integer', () => {
      process.env.PLUGIN_TEST_INT = '99';
      expect(queueModule.intFromEnv('PLUGIN_TEST_INT', 7)).toBe(99);
    });

    it('TIER_CACHE_TTL_MS is a real positive number even when the env is garbage', async () => {
      process.env.PLUGIN_TIER_CACHE_TTL_MS = 'garbage';
      jest.resetModules();
      registerMocks();
      const mod = await import('../src/queue/plugin-build-queue.js');
      expect(Number.isFinite(mod.TIER_CACHE_TTL_MS)).toBe(true);
      expect(mod.TIER_CACHE_TTL_MS).toBe(300000);
      delete process.env.PLUGIN_TIER_CACHE_TTL_MS;
    });
  });

  describe('shutdownQueue()', () => {
    it('closes worker, queue, and connection', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.getTierQueue('developer');
      queueModule.startWorker(sse, quota);

      await queueModule.shutdownQueue();

      expect(mockWorkerClose).toHaveBeenCalled();
      expect(mockQueueClose).toHaveBeenCalled();
    });

    it('handles shutdown when nothing was initialized', async () => {
      await expect(queueModule.shutdownQueue()).resolves.toBeUndefined();
    });
  });
});

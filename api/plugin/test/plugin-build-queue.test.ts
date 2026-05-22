// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/plugin-build-queue.
 *
 * Mocks BullMQ (Queue, Worker), ioredis, fs, and all external
 * services (SSEManager, QuotaService, db, buildAndPush).
 */

// Mock state  must be hoisted before imports

const mockQueueAdd = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
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

jest.mock('bullmq', () => {
  class MockQueue {
    add = mockQueueAdd;
    close = mockQueueClose;
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

jest.mock('ioredis', () => {
  class MockRedis {
    status = 'ready';
    disconnect = jest.fn();
    on = jest.fn();
    // Per-org concurrency semaphore uses INCR/DECR/EXPIRE/SET on
    // `pb:org-build:<orgId>` keys. Mock to always succeed under the cap so
    // the worker proceeds to its main logic.
    incr = jest.fn().mockResolvedValue(1);
    decr = jest.fn().mockResolvedValue(0);
    expire = jest.fn().mockResolvedValue(1);
    set = jest.fn().mockResolvedValue('OK');
  }
  return { __esModule: true, default: MockRedis };
});

const mockIncrementQuota = jest.fn();
const mockExistsSync = jest.fn().mockReturnValue(false);
const mockRmSync = jest.fn();
const mockUtimesSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: mockExistsSync,
  rmSync: mockRmSync,
  utimesSync: mockUtimesSync,
  readdirSync: jest.fn().mockReturnValue([]),
}));

const mockBuildAndPush = jest.fn();
jest.mock('../src/helpers/docker-build', () => ({
  buildAndPush: mockBuildAndPush,
  BUILD_TEMP_ROOT: '/tmp',
  // per-tier buildkitd address resolver. Stub returns a noop tcp
  // address so the worker proceeds; the actual buildAndPush mock above
  // is what asserts behavior.
  getBuildkitAddrForTier: jest.fn(() => 'tcp://buildkitd:1234'),
}));

const mockDeployVersion = jest.fn();
jest.mock('../src/services/plugin-service', () => ({
  pluginService: { deployVersion: mockDeployVersion },
}));

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

jest.mock('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: {
    PLUGIN_BUILD_COMPLETED_RETENTION_SECS: 86400,
    PLUGIN_BUILD_FAILED_RETENTION_SECS: 604800,
    PLUGIN_BUILD_QUEUE_NAME: 'plugin-build',
  },
  Config: { get: (section: string) => mockPipelineCoreConfig[section] ?? {}, getAny: (section: string) => mockPipelineCoreConfig[section] ?? {} },
  // RLS tenant-context primitives. Pass-throughs in unit tests  // runWithTenantContext just invokes its callback; withTenantTx invokes
  // its callback with a stub tx whose insert/select/update return promises
  // resolving to the inputs (existing test assertions don't inspect the
  // tx layer, just the side effects).
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  withTenantTx: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
    insert: () => ({ values: () => Promise.resolve() }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  }),
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message: String(e)),
  extractDbError: jest.fn(() => ({})),
  incrementQuota: mockIncrementQuota,
  decrementQuota: mockIncrementQuota,
  getServiceAuthHeader: () => 'Bearer test-service-token',
  // remote-audit client  worker calls record() on success +
  // permanent failure. Mocked as a no-op since the worker fire-and-forgets;
  // tests only need the symbol to exist so getAuditClient() doesn't throw.
  createRemoteAuditClient: () => ({ record: jest.fn() }),
}));

jest.mock('@pipeline-builder/api-server', () => ({
  // Metrics helpers used by worker handlers + queue-metrics-scraper.
  // No-ops in tests  we only assert behavior, not Prometheus state.
  incCounter: jest.fn(),
  observe: jest.fn(),
  setGauge: jest.fn(),
}));

// Import after mocks

import type { PluginBuildJobData } from '../src/helpers/plugin-helpers';

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
  return capturedProcessors['plugin-build'];
}

// Tests

describe('plugin-build-queue', () => {
  let queueModule: typeof import('../src/queue/plugin-build-queue');

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.keys(capturedProcessors).forEach((k) => delete capturedProcessors[k]);
    mockExistsSync.mockReturnValue(false);

    jest.resetModules();

    // Re-apply mocks after resetModules
    jest.mock('bullmq', () => {
      class MockQueue {
        add = mockQueueAdd;
        close = mockQueueClose;
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

    jest.mock('ioredis', () => {
      class MockRedis {
        status = 'ready';
        disconnect = jest.fn();
        on = jest.fn();
        incr = jest.fn().mockResolvedValue(1);
        decr = jest.fn().mockResolvedValue(0);
        expire = jest.fn().mockResolvedValue(1);
        set = jest.fn().mockResolvedValue('OK');
      }
      return { __esModule: true, default: MockRedis };
    });

    jest.mock('fs', () => ({
      existsSync: mockExistsSync,
      rmSync: mockRmSync,
      utimesSync: mockUtimesSync,
      readdirSync: jest.fn().mockReturnValue([]),
    }));

    jest.mock('../src/helpers/docker-build', () => ({
      buildAndPush: mockBuildAndPush,
      BUILD_TEMP_ROOT: '/tmp',
      getBuildkitAddrForTier: jest.fn(() => 'tcp://buildkitd:1234'),
    }));

    jest.mock('../src/services/plugin-service', () => ({
      pluginService: { deployVersion: mockDeployVersion },
    }));


    jest.mock('@pipeline-builder/pipeline-core', () => ({
      CoreConstants: {
        PLUGIN_BUILD_COMPLETED_RETENTION_SECS: 86400,
        PLUGIN_BUILD_FAILED_RETENTION_SECS: 604800,
        PLUGIN_BUILD_QUEUE_NAME: 'plugin-build',
      },
      Config: { get: (section: string) => mockPipelineCoreConfig[section] ?? {}, getAny: (section: string) => mockPipelineCoreConfig[section] ?? {} },
      runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
      withTenantTx: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
        insert: () => ({ values: () => Promise.resolve() }),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
      }),
    }));

    jest.mock('@pipeline-builder/api-core', () => ({
      createLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      errorMessage: (e: unknown) => (e instanceof Error ? e.message: String(e)),
      extractDbError: jest.fn(() => ({})),
      incrementQuota: mockIncrementQuota,
      decrementQuota: mockIncrementQuota,
      getServiceAuthHeader: () => 'Bearer test-service-token',
      // remote-audit client  worker fire-and-forgets.
      createRemoteAuditClient: () => ({ record: jest.fn() }),
      // per-tier queues  startWorker iterates VALID_TIERS.
      VALID_TIERS: ['developer', 'pro', 'unlimited'],
      DEFAULT_TIER: 'developer',
    }));

    jest.mock('@pipeline-builder/api-server', () => ({
      // Metrics helpers used by worker handlers + queue-metrics-scraper.
      // No-ops in tests  we only assert behavior, not Prometheus state.
      incCounter: jest.fn(),
      observe: jest.fn(),
      setGauge: jest.fn(),
    }));

    queueModule = await import('../src/queue/plugin-build-queue');
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

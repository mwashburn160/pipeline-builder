/**
 * Tests for queue/plugin-build-queue.
 *
 * Mocks BullMQ (Queue, Worker), ioredis, fs, and all external
 * services (SSEManager, QuotaService, db, buildAndPush).
 */

// Mock state — must be hoisted before imports

const mockQueueAdd = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerOn = jest.fn();
let capturedWorkerProcessor: ((job: any) => Promise<any>) | null = null;

jest.mock('bullmq', () => {
  class MockQueue {
    add = mockQueueAdd;
    close = mockQueueClose;
  }

  class MockWorker {
    on = mockWorkerOn;
    close = mockWorkerClose;

    constructor(_name: string, processor: (job: any) => Promise<any>, _opts: any) {
      capturedWorkerProcessor = processor;
    }
  }

  return { Queue: MockQueue, Worker: MockWorker };
});

jest.mock('ioredis', () => {
  class MockRedis {
    status = 'ready';
    disconnect = jest.fn();
    on = jest.fn();
  }
  return { __esModule: true, default: MockRedis };
});

const mockIncrementQuota = jest.fn();
const mockExistsSync = jest.fn().mockReturnValue(false);
const mockRmSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: mockExistsSync,
  rmSync: mockRmSync,
}));

const mockBuildAndPush = jest.fn();
jest.mock('../src/helpers/docker-build', () => ({
  buildAndPush: mockBuildAndPush,
}));

const mockDeployVersion = jest.fn();
jest.mock('../src/services/plugin-service', () => ({
  pluginService: { deployVersion: mockDeployVersion },
}));

const mockPipelineCoreConfig: Record<string, any> = {
  pluginBuild: { concurrency: 1 },
  redis: { host: 'localhost', port: 6379 },
};

jest.mock('@mwashburn160/pipeline-core', () => ({
  CoreConstants: {
    PLUGIN_BUILD_COMPLETED_RETENTION_SECS: 86400,
    PLUGIN_BUILD_FAILED_RETENTION_SECS: 604800,
    PLUGIN_BUILD_QUEUE_NAME: 'plugin-build',
  },
  Config: { get: (section: string) => mockPipelineCoreConfig[section] ?? {} },
  // db and schema are re-exported from pipeline-data — mock that module directly
}));

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  extractDbError: jest.fn(() => ({})),
  incrementQuota: mockIncrementQuota,
}));

jest.mock('@mwashburn160/api-server', () => ({}));

// Import after mocks

import type { PluginBuildJobData } from '../src/helpers/plugin-helpers';

// Helpers

function makeSseManager() {
  return { send: jest.fn() } as any;
}

function makeQuotaService() {
  return { increment: jest.fn().mockResolvedValue(undefined) } as any;
}

function makeJobData(overrides: Partial<PluginBuildJobData> = {}): PluginBuildJobData {
  return {
    requestId: 'req-123',
    orgId: 'org-1',
    userId: 'user-1',
    authToken: 'Bearer tok',
    buildRequest: {
      contextDir: '/tmp/build-ctx',
      dockerfile: 'Dockerfile',
      imageTag: 'p-test-abc123',
      registry: { host: 'registry', port: 5000, user: 'admin', token: 'secret', network: '', http: true, insecure: true },
    },
    pluginRecord: {
      orgId: 'org-1',
      name: 'my-plugin',
      description: 'Test plugin',
      version: '1.0.0',
      metadata: {},
      pluginType: 'docker',
      computeType: 'small',
      primaryOutputDirectory: null,
      dockerfile: 'Dockerfile',
      env: {},
      buildArgs: {},
      keywords: ['test'],
      installCommands: [],
      commands: ['echo hello'],
      imageTag: 'p-test-abc123',
      accessModifier: 'private',
      timeout: null,
      failureBehavior: 'fail',
      secrets: [],
    },
    ...overrides,
  };
}

function makeJob(data: PluginBuildJobData) {
  return {
    id: 'job-1',
    data,
    attemptsMade: 1,
    opts: { attempts: 2 },
  };
}

// Tests

describe('plugin-build-queue', () => {
  // Re-require the module fresh for each test to reset singleton state
  let queueModule: typeof import('../src/queue/plugin-build-queue');

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedWorkerProcessor = null;

    // Reset the module registry to clear singleton state (queue, worker, connection)
    jest.resetModules();

    // Re-apply mocks after resetModules
    jest.mock('bullmq', () => {
      class MockQueue {
        add = mockQueueAdd;
        close = mockQueueClose;
      }
      class MockWorker {
        on = mockWorkerOn;
        close = mockWorkerClose;
        constructor(_name: string, processor: (job: any) => Promise<any>, _opts: any) {
          capturedWorkerProcessor = processor;
        }
      }
      return { Queue: MockQueue, Worker: MockWorker };
    });

    jest.mock('ioredis', () => {
      class MockRedis { status = 'ready'; disconnect = jest.fn(); on = jest.fn(); }
      return { __esModule: true, default: MockRedis };
    });

    jest.mock('fs', () => ({
      existsSync: mockExistsSync,
      rmSync: mockRmSync,
    }));

    jest.mock('../src/helpers/docker-build', () => ({
      buildAndPush: mockBuildAndPush,
    }));

    jest.mock('../src/services/plugin-service', () => ({
      pluginService: { deployVersion: mockDeployVersion },
    }));

    jest.mock('@mwashburn160/pipeline-core', () => ({
      CoreConstants: {
        PLUGIN_BUILD_COMPLETED_RETENTION_SECS: 86400,
        PLUGIN_BUILD_FAILED_RETENTION_SECS: 604800,
        PLUGIN_BUILD_QUEUE_NAME: 'plugin-build',
      },
      Config: { get: (section: string) => mockPipelineCoreConfig[section] ?? {} },
    }));

    jest.mock('@mwashburn160/api-core', () => ({
      createLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
      extractDbError: jest.fn(() => ({})),
      incrementQuota: mockIncrementQuota,
    }));

    jest.mock('@mwashburn160/api-server', () => ({}));

    // Fresh import (dynamic import to satisfy ESLint no-require-imports rule)
    queueModule = await import('../src/queue/plugin-build-queue');
  });

  describe('getQueue()', () => {
    it('returns a BullMQ Queue instance', () => {
      const q = queueModule.getQueue();
      expect(q).toBeDefined();
      expect(q.add).toBeDefined();
    });

    it('returns the same instance on subsequent calls (singleton)', () => {
      const q1 = queueModule.getQueue();
      const q2 = queueModule.getQueue();
      expect(q1).toBe(q2);
    });
  });

  describe('startWorker()', () => {
    it('creates a Worker and returns it', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      const w = queueModule.startWorker(sse, quota);
      expect(w).toBeDefined();
      expect(capturedWorkerProcessor).toBeInstanceOf(Function);
    });

    it('returns same worker on repeated calls (singleton)', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      const w1 = queueModule.startWorker(sse, quota);
      const w2 = queueModule.startWorker(sse, quota);
      expect(w1).toBe(w2);
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

      const insertedPlugin = { id: 'plugin-1', name: 'my-plugin', version: '1.0.0', imageTag: 'p-test-abc123' };
      mockBuildAndPush.mockResolvedValue({ fullImage: 'registry:5000/plugin:p-test-abc123' });
      mockDeployVersion.mockResolvedValue(insertedPlugin);

      const jobData = makeJobData();
      const job = makeJob(jobData);

      const result = await capturedWorkerProcessor!(job);

      // Verify buildAndPush was called
      expect(mockBuildAndPush).toHaveBeenCalledWith(jobData.buildRequest);

      // Verify deployVersion was called with plugin record and userId
      expect(mockDeployVersion).toHaveBeenCalledWith(jobData.pluginRecord, 'user-1');

      // Verify SSE events
      expect(sse.send).toHaveBeenCalledWith('req-123', 'INFO', 'Build started', expect.any(Object));
      expect(sse.send).toHaveBeenCalledWith('req-123', 'INFO', 'Image pushed', expect.any(Object));
      expect(sse.send).toHaveBeenCalledWith('req-123', 'COMPLETED', 'Plugin deployed', expect.objectContaining({
        id: 'plugin-1',
        name: 'my-plugin',
      }));

      // Verify quota increment
      expect(mockIncrementQuota).toHaveBeenCalledWith(quota, 'org-1', 'plugins', 'Bearer tok', expect.any(Function));

      // Verify return value
      expect(result).toEqual({ pluginId: 'plugin-1', fullImage: 'registry:5000/plugin:p-test-abc123' });
    });

    it('cleans up temp directory after success', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const insertedPlugin = { id: 'p1', name: 'test', version: '1.0.0', imageTag: 'tag' };
      mockBuildAndPush.mockResolvedValue({ fullImage: 'img' });
      mockDeployVersion.mockResolvedValue(insertedPlugin);
      mockExistsSync.mockReturnValue(true);

      await capturedWorkerProcessor!(makeJob(makeJobData()));

      expect(mockRmSync).toHaveBeenCalledWith('/tmp/build-ctx', { recursive: true, force: true });
    });

    it('does not clean up temp directory on non-final attempt failure (preserves for retry)', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      mockBuildAndPush.mockRejectedValue(new Error('Docker build failed'));
      mockExistsSync.mockReturnValue(true);

      // attemptsMade=1, attempts=2 → not final, should preserve context for retry
      await expect(capturedWorkerProcessor!(makeJob(makeJobData()))).rejects.toThrow('Docker build failed');

      expect(mockRmSync).not.toHaveBeenCalled();
    });

    it('cleans up temp directory after final attempt failure', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      mockBuildAndPush.mockRejectedValue(new Error('Docker build failed'));
      mockExistsSync.mockReturnValue(true);

      // attemptsMade=2 >= attempts=2 → final attempt, should clean up
      const job = { ...makeJob(makeJobData()), attemptsMade: 2 };
      await expect(capturedWorkerProcessor!(job)).rejects.toThrow('Docker build failed');

      expect(mockRmSync).toHaveBeenCalledWith('/tmp/build-ctx', { recursive: true, force: true });
    });

    it('does not throw if temp dir cleanup fails', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const insertedPlugin = { id: 'p1', name: 'test', version: '1.0.0', imageTag: 'tag' };
      mockBuildAndPush.mockResolvedValue({ fullImage: 'img' });
      mockDeployVersion.mockResolvedValue(insertedPlugin);
      mockExistsSync.mockReturnValue(true);
      mockRmSync.mockImplementation(() => { throw new Error('permission denied'); });

      // Should not throw — cleanup error is caught internally
      await expect(capturedWorkerProcessor!(makeJob(makeJobData()))).resolves.toBeDefined();
    });
  });

  describe('worker failed event handler', () => {
    it('sends SSE error event on job failure', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      // Find the 'failed' handler
      const failedCall = mockWorkerOn.mock.calls.find((c: any) => c[0] === 'failed');
      expect(failedCall).toBeDefined();
      const failedHandler = failedCall![1];

      const jobData = makeJobData();
      const job = makeJob(jobData);
      const error = new Error('Build timeout');

      failedHandler(job, error);

      expect(sse.send).toHaveBeenCalledWith('req-123', 'ERROR', 'Build failed: Build timeout', expect.objectContaining({
        jobId: 'job-1',
        attemptsMade: 1,
        maxAttempts: 2,
      }));
    });

    it('handles null job gracefully', () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      queueModule.startWorker(sse, quota);

      const failedCall = mockWorkerOn.mock.calls.find((c: any) => c[0] === 'failed');
      const failedHandler = failedCall![1];

      // Should not throw when job is null/undefined
      expect(() => failedHandler(null, new Error('Connection lost'))).not.toThrow();
      expect(sse.send).not.toHaveBeenCalled();
    });
  });

  describe('shutdownQueue()', () => {
    it('closes worker, queue, and connection', async () => {
      const sse = makeSseManager();
      const quota = makeQuotaService();

      // Create queue and worker
      queueModule.getQueue();
      queueModule.startWorker(sse, quota);

      await queueModule.shutdownQueue();

      expect(mockWorkerClose).toHaveBeenCalled();
      expect(mockQueueClose).toHaveBeenCalled();
    });

    it('handles shutdown when nothing was initialized', async () => {
      // Should not throw even if queue/worker/connection are null
      await expect(queueModule.shutdownQueue()).resolves.toBeUndefined();
    });
  });
});

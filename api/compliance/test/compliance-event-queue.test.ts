// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const queueAdd = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const queueClose = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const queueOn = jest.fn();

// Per-queue `add` spies keyed by queue name so the DLQ test can assert a job
// landed on 'compliance-events-dlq' specifically, not the main queue.
const addByQueue = new Map<string, jest.Mock>();
function addSpyFor(name: string): jest.Mock {
  let spy = addByQueue.get(name);
  if (!spy) {
    spy = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined) as unknown as jest.Mock;
    addByQueue.set(name, spy);
  }
  return spy;
}

const workerClose = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
// Capture the 'failed' listener the worker registers so the DLQ test can drive it.
let failedListener: ((job: unknown, err: Error) => void) | null = null;
const workerOn = jest.fn((event: string, listener: (...a: unknown[]) => void) => {
  if (event === 'failed') failedListener = listener as (job: unknown, err: Error) => void;
});
let workerProcessor: ((job: { id: string; data: unknown }) => Promise<unknown>) | null = null;

class MockQueue {
  add: jest.Mock;
  close = queueClose;
  on = queueOn;
  constructor(name: string, _opts: unknown) {
    // Route to a name-specific spy AND the shared queueAdd (back-compat with
    // the existing enqueue assertions, which target the main queue).
    const named = addSpyFor(name);
    this.add = jest.fn<(...args: unknown[]) => Promise<unknown>>((...args: unknown[]) => {
      void named(...args);
      return queueAdd(...args);
    }) as unknown as jest.Mock;
  }
}

class MockWorker {
  close = workerClose;
  on = workerOn;
  constructor(_name: string, processor: (job: { id: string; data: unknown }) => Promise<unknown>, _opts: unknown) {
    workerProcessor = processor;
  }
}

jest.unstable_mockModule('bullmq', () => ({
  Queue: jest.fn().mockImplementation((...args: unknown[]) => new MockQueue(args[0] as string, args[1])),
  Worker: jest.fn().mockImplementation((...args: unknown[]) => new MockWorker(args[0] as string, args[1] as (job: { id: string; data: unknown }) => Promise<unknown>, args[2])),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { enqueue, startComplianceWorker, stopComplianceWorker } = await import('../src/queue/compliance-event-queue.js');

const sampleEvent = {
  entityId: 'e1',
  orgId: 'org-1',
  target: 'plugin',
  eventType: 'created',
} as never;

describe('compliance-event-queue', () => {
  beforeEach(() => {
    queueAdd.mockClear();
    queueClose.mockClear();
    workerClose.mockClear();
    workerOn.mockClear();
    addByQueue.forEach((spy) => spy.mockClear());
    workerProcessor = null;
    failedListener = null;
  });

  describe('enqueue', () => {
    it('adds a job with composite name from event type/target/entityId', async () => {
      await enqueue(sampleEvent);
      expect(queueAdd).toHaveBeenCalledWith('created:plugin:e1', sampleEvent);
    });

    it('includes the event payload in the job', async () => {
      const ev = { ...(sampleEvent as Record<string, unknown>), entityId: 'e2', eventType: 'deleted', target: 'pipeline' } as never;
      await enqueue(ev);
      expect(queueAdd).toHaveBeenCalledWith('deleted:pipeline:e2', ev);
    });
  });

  describe('worker lifecycle', () => {
    afterEach(async () => {
      // Reset worker singleton between tests
      await stopComplianceWorker().catch(() => undefined);
    });

    it('starts a worker and registers event listeners', () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      startComplianceWorker(handler);

      expect(workerProcessor).not.toBeNull();
      // 3 listeners: failed, completed, error
      const events = workerOn.mock.calls.map(c => c[0]);
      expect(events).toEqual(expect.arrayContaining(['failed', 'completed', 'error']));
    });

    it('worker processor invokes handler with job data', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      startComplianceWorker(handler);
      await workerProcessor!({ id: 'job-1', data: sampleEvent });
      expect(handler).toHaveBeenCalledWith(sampleEvent);
    });

    it('does nothing when called twice (singleton)', () => {
      const handler = jest.fn();
      startComplianceWorker(handler);
      const firstCalls = workerOn.mock.calls.length;
      startComplianceWorker(handler);
      expect(workerOn.mock.calls.length).toBe(firstCalls);
    });

    it('stopComplianceWorker closes worker and queue', async () => {
      const handler = jest.fn();
      startComplianceWorker(handler);
      await stopComplianceWorker();
      expect(workerClose).toHaveBeenCalled();
      expect(queueClose).toHaveBeenCalled();
    });
  });

  describe('dead-letter queue (governance path must not silently drop jobs)', () => {
    const DLQ_NAME = 'compliance-events-dlq';
    const flush = () => new Promise((r) => setImmediate(r));

    afterEach(async () => {
      await stopComplianceWorker().catch(() => undefined);
    });

    it('moves a job that exhausts its retries to the DLQ instead of dropping it', async () => {
      const handler = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('boom'));
      startComplianceWorker(handler);
      expect(failedListener).not.toBeNull();

      // Final attempt: attemptsMade has reached opts.attempts.
      const job = { id: 'job-9', name: 'validate:plugin:e1', data: sampleEvent, attemptsMade: 3, opts: { attempts: 3 } };
      failedListener!(job, new Error('boom'));
      await flush();

      const dlqAdd = addByQueue.get(DLQ_NAME);
      expect(dlqAdd).toBeDefined();
      expect(dlqAdd!).toHaveBeenCalledTimes(1);

      const [name, payload] = dlqAdd!.mock.calls[0] as [string, Record<string, unknown>];
      expect(name).toContain('dlq:');
      // The original event survives, enriched with forensic metadata.
      expect(payload).toMatchObject({ entityId: 'e1', target: 'plugin', eventType: 'created' });
      expect(payload.failedReason).toBe('boom');
      expect(payload.attemptsMade).toBe(3);
      expect(typeof payload.failedAt).toBe('string');
    });

    it('does NOT dead-letter a job that still has retries left', async () => {
      const handler = jest.fn();
      startComplianceWorker(handler);

      // attemptsMade (1) < opts.attempts (3): BullMQ will retry, so no DLQ.
      const job = { id: 'job-10', name: 'validate:plugin:e2', data: sampleEvent, attemptsMade: 1, opts: { attempts: 3 } };
      failedListener!(job, new Error('transient'));
      await flush();

      const dlqAdd = addByQueue.get(DLQ_NAME);
      expect(dlqAdd?.mock.calls.length ?? 0).toBe(0);
    });

    it('stopComplianceWorker closes the DLQ once it has been created', async () => {
      const handler = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('boom'));
      startComplianceWorker(handler);
      const job = { id: 'job-11', name: 'validate:plugin:e1', data: sampleEvent, attemptsMade: 3, opts: { attempts: 3 } };
      failedListener!(job, new Error('boom'));
      await flush();

      queueClose.mockClear();
      await stopComplianceWorker();
      // Main queue + DLQ both close (queueClose is shared across MockQueue instances).
      expect(queueClose).toHaveBeenCalledTimes(2);
    });
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const queueAdd = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const queueClose = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const queueOn = jest.fn();

const workerClose = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const workerOn = jest.fn();
let workerProcessor: ((job: { id: string; data: unknown }) => Promise<unknown>) | null = null;

class MockQueue {
  add = queueAdd;
  close = queueClose;
  on = queueOn;
  constructor(_name: string, _opts: unknown) {
    // no-op
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
    workerProcessor = null;
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
});

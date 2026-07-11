// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the digest scheduler's pure decision/aggregation helpers:
 * when a digest is due, and how parked entries collapse into one notification.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createScheduler: () => ({ start: jest.fn(), stop: jest.fn() }) }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { getAny: () => ({}) },
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  Config: { getAny: () => ({}) },
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
}));;
jest.unstable_mockModule('../src/helpers/compliance-notifier.js', () => ({ dispatchImmediate: jest.fn() }));
// Avoid loading the real BullMQ queue (it would connect to Redis on import).
jest.unstable_mockModule('../src/queue/compliance-event-queue.js', () => ({ getLockRedis: jest.fn() }));
jest.unstable_mockModule('../src/services/notification-service.js', () => ({
  getNotificationPreference: jest.fn(),
  getOrgsWithPendingDigests: jest.fn(),
  getPendingDigests: jest.fn(),
  markDigestsSent: jest.fn(),
  touchLastDigestAt: jest.fn(),
}));

const { isDigestDue, buildDigest } = await import('../src/helpers/digest-scheduler.js');

const NOW = new Date('2026-06-18T12:00:00Z');

describe('isDigestDue', () => {
  it('flushes when there is no preference or it reverted to immediate (avoid stranding)', () => {
    expect(isDigestDue(null, NOW)).toBe(true);
    expect(isDigestDue({ digestMode: 'immediate' } as any, NOW)).toBe(true);
  });

  it('flushes when never flushed before', () => {
    expect(isDigestDue({ digestMode: 'daily', lastDigestAt: null } as any, NOW)).toBe(true);
  });

  it('daily: due only after >= 24h', () => {
    expect(isDigestDue({ digestMode: 'daily', lastDigestAt: new Date('2026-06-18T11:00:00Z') } as any, NOW)).toBe(false);
    expect(isDigestDue({ digestMode: 'daily', lastDigestAt: new Date('2026-06-17T11:59:00Z') } as any, NOW)).toBe(true);
  });

  it('weekly: due only after >= 7d', () => {
    expect(isDigestDue({ digestMode: 'weekly', lastDigestAt: new Date('2026-06-15T12:00:00Z') } as any, NOW)).toBe(false);
    expect(isDigestDue({ digestMode: 'weekly', lastDigestAt: new Date('2026-06-10T12:00:00Z') } as any, NOW)).toBe(true);
  });
});

describe('buildDigest', () => {
  const entry = (subject: string, priority: 'urgent' | 'high' | 'normal') => ({
    id: subject,
    notification: { recipientOrgId: 'o1', messageType: 'conversation', priority, subject, content: 'c', payload: { event: 'compliance.block' } },
  });

  it('summarises all parked subjects and counts them', () => {
    const d = buildDigest('o1', [entry('A blocked', 'high'), entry('B warnings', 'normal')] as any);
    expect(d.subject).toContain('2 notifications');
    expect(d.content).toContain('A blocked');
    expect(d.content).toContain('B warnings');
    expect((d.payload as { count: number }).count).toBe(2);
  });

  it('priority is high when any entry is high/urgent, else normal', () => {
    expect(buildDigest('o1', [entry('x', 'normal'), entry('y', 'urgent')] as any).priority).toBe('high');
    expect(buildDigest('o1', [entry('x', 'normal')] as any).priority).toBe('normal');
  });

  it('singularises the subject for a single entry', () => {
    expect(buildDigest('o1', [entry('only', 'normal')] as any).subject).toContain('1 notification');
    expect(buildDigest('o1', [entry('only', 'normal')] as any).subject).not.toContain('notifications');
  });
});

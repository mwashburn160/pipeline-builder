// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A malformed `COMPLIANCE_NOTIFY_TIMEOUT_MS` must fall back to the default, not
 * NaN: `setTimeout(fn, NaN)` fires after ~1ms, which aborted every channel
 * delivery immediately. Uses api-core's real `envInt`.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.COMPLIANCE_NOTIFY_TIMEOUT_MS = 'not-a-number';

const { envInt } = await import('@pipeline-builder/api-core/lib/utils/env.js');
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ envInt }));

const delivered: AbortSignal[] = [];
jest.unstable_mockModule('../src/helpers/notification-channels.js', () => ({
  getNotificationChannel: () => ({
    channel: 'in-app',
    deliver: async (_n: unknown, _t: unknown, signal: AbortSignal) => { delivered.push(signal); return { ok: true }; },
  }),
}));
jest.unstable_mockModule('../src/services/notification-service.js', () => ({
  getNotificationPreference: async () => null,
  recordNotificationLog: async () => undefined,
  recordPendingDigest: async () => undefined,
}));

const { notifyComplianceBlock } = await import('../src/helpers/compliance-notifier.js');

describe('compliance notifier delivery timeout', () => {
  it('falls back to the 5000ms default when the env override is non-numeric', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    try {
      await notifyComplianceBlock('org-a', 'plugin', 'p', [{
        ruleId: 'r',
        ruleName: 'r',
        field: 'f',
        operator: 'eq',
        expectedValue: 1,
        actualValue: 2,
        severity: 'error',
        message: 'm',
        suppressNotification: false,
      }]);
      expect(delivered).toHaveLength(1);
      const delays = spy.mock.calls.map((c) => c[1]);
      expect(delays).toContain(5000);
      expect(delays.some((d) => Number.isNaN(d))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

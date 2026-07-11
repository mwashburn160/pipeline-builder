// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the notification-preferences presenter — the security-critical
 * invariant is that the webhook secret is never echoed back to clients (only a
 * `hasWebhookSecret` flag), and that an org with no saved row gets sane defaults.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  validateBody: jest.fn(),
  requirePermission: () => jest.fn(),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ withRoute: (fn: unknown) => fn }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({ schema: { complianceNotificationPreference: {} }, withTenantTx: jest.fn() }));
jest.unstable_mockModule('../src/services/notification-service.js', () => ({
  getNotificationPreference: jest.fn(),
  upsertNotificationPreference: jest.fn(),
}));

const { toApiPreference } = await import('../src/routes/notification-preferences.js');

describe('toApiPreference', () => {
  it('returns column defaults (with hasWebhookSecret false) when no row exists', () => {
    expect(toApiPreference(null)).toEqual({
      notifyOnBlock: true,
      notifyOnWarning: false,
      emailEnabled: false,
      digestMode: 'immediate',
      targetUsers: null,
      webhookUrl: null,
      hasWebhookSecret: false,
    });
  });

  it('never echoes the webhook secret — exposes only hasWebhookSecret', () => {
    const api = toApiPreference({
      orgId: 'o1',
      notifyOnBlock: false,
      notifyOnWarning: true,
      emailEnabled: true,
      digestMode: 'daily',
      targetUsers: ['u1'],
      webhookUrl: 'https://h',
      webhookSecret: 'super-secret',
    } as any);
    expect(api).not.toHaveProperty('webhookSecret');
    expect(api.hasWebhookSecret).toBe(true);
    expect(api).toMatchObject({ notifyOnBlock: false, notifyOnWarning: true, emailEnabled: true, targetUsers: ['u1'], webhookUrl: 'https://h' });
  });

  it('normalises a null secret to hasWebhookSecret false', () => {
    const api = toApiPreference({
      orgId: 'o1',
      notifyOnBlock: true,
      notifyOnWarning: false,
      emailEnabled: false,
      digestMode: 'immediate',
      targetUsers: null,
      webhookUrl: null,
      webhookSecret: null,
    } as any);
    expect(api.hasWebhookSecret).toBe(false);
  });
});

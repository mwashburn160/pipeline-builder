// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the notification-preferences presenter — the security-critical
 * invariant is that the webhook secret is never echoed back to clients (only a
 * `hasWebhookSecret` flag), and that an org with no saved row gets sane defaults.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRecordAudit = jest.fn<(event: any) => void>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: jest.fn(),
  sendBadRequest: jest.fn(),
  // Faithful enough for the PUT handler: the route's own `.strict()` schema
  // decides what is accepted, which is what the provenance tests below rely on.
  validateBody: (req: any, schema: any) => {
    const r = schema.safeParse(req?.body);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
  },
  requirePermission: () => jest.fn(),
  recordAudit: (event: any) => mockRecordAudit(event),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: () => undefined, withRoute: (fn: unknown) => fn }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', { schema: { complianceNotificationPreference: {} }, withTenantTx: jest.fn() }));
const mockUpsert = jest.fn<(...a: unknown[]) => Promise<unknown>>()
  .mockResolvedValue({ notifyOnBlock: true, notifyOnWarning: false, emailEnabled: true, digestMode: 'immediate', targetUsers: null, webhookUrl: null, webhookSecret: null });
jest.unstable_mockModule('../src/services/notification-service.js', () => ({
  getNotificationPreference: jest.fn(),
  upsertNotificationPreference: (...a: unknown[]) => mockUpsert(...a),
}));

const { toApiPreference, createNotificationPreferenceRoutes } = await import('../src/routes/notification-preferences.js');

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

/**
 * Design rule 6: the Ask panel commits a compliance-notification proposal
 * through this route with the user's own session, so the audit event must be
 * able to say an AI drafted it — and only that, from exactly one header value.
 */
describe('PUT / — ask-agent provenance', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const router: any = createNotificationPreferenceRoutes();
  const putLayer = () => router.stack.find((l: any) => l.route?.path === '/' && l.route?.methods.put)?.route;

  const put = async (headers: Record<string, unknown>) => {
    mockRecordAudit.mockClear();
    const stack = putLayer().stack;
    const handler = stack[stack.length - 1].handle;
    const res: any = { status: () => res, json: () => res };
    await handler({
      req: { body: { emailEnabled: true }, headers },
      res,
      ctx: { log: jest.fn() },
      orgId: 'acme',
      userId: 'u-1',
    });
    return mockRecordAudit.mock.calls[0][0].details;
  };

  it('is gated by `proposable`, ahead of the handler', () => {
    const names = putLayer().stack.map((l: any) => l.handle.name);
    expect(names).toContain('proposable');
    expect(names.indexOf('proposable')).toBeLessThan(names.length - 1);
  });

  it('records proposedBy when the request carries the marker', async () => {
    expect(await put({ 'x-pb-proposed-by': 'ask-agent' }))
      .toEqual({ fields: ['emailEnabled'], webhookHost: null, webhookSecretSet: false, proposedBy: 'ask-agent' });
  });

  it('records NO proposer for an ordinary admin save', async () => {
    expect(await put({})).not.toHaveProperty('proposedBy');
  });

  it('does NOT store a forged proposer', async () => {
    expect(await put({ 'x-pb-proposed-by': 'u-1' })).not.toHaveProperty('proposedBy');
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

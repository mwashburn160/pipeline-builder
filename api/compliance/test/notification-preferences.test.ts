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
const mockGetPreference = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue(null);
jest.unstable_mockModule('../src/services/notification-service.js', () => ({
  getNotificationPreference: (...a: unknown[]) => mockGetPreference(...a),
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

/**
 * A webhook URL is often bearer-equivalent (a Slack/Teams incoming webhook
 * carries its token in the path), so only a caller who may change it sees it
 * in full; a `compliance:read` member sees the host only.
 */
describe('GET / — webhook URL disclosure', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const router: any = createNotificationPreferenceRoutes();
  const getLayer = () => router.stack.find((l: any) => l.route?.path === '/' && l.route?.methods.get)?.route;
  const stored = {
    orgId: 'acme',
    notifyOnBlock: true,
    notifyOnWarning: false,
    emailEnabled: false,
    digestMode: 'immediate',
    targetUsers: null,
    webhookUrl: 'https://hooks.example.com/services/T000/B000/XXXXSECRET',
    webhookSecret: null,
  };

  const get = async (permissions: string[]) => {
    mockGetPreference.mockResolvedValueOnce(stored);
    const stack = getLayer().stack;
    const handler = stack[stack.length - 1].handle;
    let body: any;
    const res: any = { status: () => res, json: (b: any) => { body = b; return res; } };
    const sendSuccess = (await import('@pipeline-builder/api-core')).sendSuccess as any;
    sendSuccess.mockImplementationOnce((_r: unknown, _s: number, b: unknown) => { body = b; });
    await handler({ req: { user: { permissions }, headers: {} }, res, ctx: { log: jest.fn() }, orgId: 'acme', userId: 'u-1' });
    return body.preference.webhookUrl;
  };

  it('shows the full URL to a caller holding compliance:write', async () => {
    expect(await get(['compliance:read', 'compliance:write'])).toBe(stored.webhookUrl);
  });

  it('shows only the host to a read-only member', async () => {
    const url = await get(['compliance:read']);
    expect(url).not.toContain('XXXXSECRET');
    expect(url).toBe('https://hooks.example.com/…');
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

/**
 * The columns are `webhook_url VARCHAR(500)` and `webhook_secret VARCHAR(255)`:
 * an over-long value used to pass the schema and surface as a Postgres error
 * (a 500) instead of a 400.
 */
describe('PUT / — column-length validation', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const router: any = createNotificationPreferenceRoutes();
  const putLayer = () => router.stack.find((l: any) => l.route?.path === '/' && l.route?.methods.put)?.route;

  const put = async (body: Record<string, unknown>) => {
    mockUpsert.mockClear();
    const stack = putLayer().stack;
    const handler = stack[stack.length - 1].handle;
    const res: any = { status: () => res, json: () => res };
    await handler({ req: { body, headers: {} }, res, ctx: { log: jest.fn() }, orgId: 'acme', userId: 'u-1' });
  };

  it.each([
    ['a webhook URL over 500 characters', { webhookUrl: `https://hooks.example.com/${'a'.repeat(500)}` }],
    ['a webhook secret over 255 characters', { webhookSecret: 's'.repeat(256) }],
    ['more than 500 target users', { targetUsers: Array.from({ length: 501 }, (_, i) => `u${i}`) }],
  ])('refuses %s before it reaches the database', async (_label, body) => {
    await put(body);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

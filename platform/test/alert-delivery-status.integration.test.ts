// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for per-destination alert delivery health
 * (services/alert-delivery-status.ts):
 *   - a failure streak is counted, and a success resets it;
 *   - the org's admins are emailed ONCE per streak, at the threshold;
 *   - the health gauges count ORGS per channel, so one tenant's broken webhook
 *     is 1 failing org of N — the platform alert's ratio, not a page.
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped by default).
 */

import { jest, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

const sent: Array<{ to: unknown; subject: string }> = [];
jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { send: async (o: { to: unknown; subject: string }) => { sent.push(o); return true; } },
}));
const gauges = new Map<string, number>();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: () => undefined,
  setGauge: (name: string, labels: Record<string, string>, v: number) => { gauges.set(`${name}{${labels.channel},${labels.state}}`, v); },
}));

suite('alert delivery status (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, m: any, svc: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  let orgId: string;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    m = await import('../src/models/index.js');
    await m.AlertDestinationStatus.init();
    svc = await import('../src/services/alert-delivery-status.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    for (const model of [m.AlertDestinationStatus, m.Organization, m.User, m.UserOrganization]) await model.deleteMany({});
    sent.length = 0;
    gauges.clear();
    const org = await m.Organization.create({ name: 'Acme', owner: new mongoose.Types.ObjectId() });
    orgId = String(org._id);
    const admin = await m.User.create({ username: 'boss', email: 'boss@acme.com', isEmailVerified: true });
    const member = await m.User.create({ username: 'dev', email: 'dev@acme.com', isEmailVerified: true });
    await m.UserOrganization.create({ userId: admin._id, organizationId: org._id, role: 'owner', isActive: true });
    await m.UserOrganization.create({ userId: member._id, organizationId: org._id, role: 'member', isActive: true });
  });

  const dest = (id = 'd-1', over: Record<string, unknown> = {}) => ({ id, orgId, channel: 'slack', label: 'Ops Slack', ...over });

  it('counts a failure streak, emails the admins once at the threshold, and resets on success', async () => {
    for (let i = 0; i < svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD + 2; i += 1) {
      await svc.recordDeliveryOutcome(dest(), { ok: false, kind: 'rejected' });
    }
    let status = (await svc.deliveryStatusesFor(['d-1'])).get('d-1');
    expect(status).toMatchObject({ lastOk: false, lastErrorKind: 'rejected', consecutiveFailures: svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD + 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['boss@acme.com']);
    expect(sent[0].subject).toContain('Ops Slack');

    await svc.recordDeliveryOutcome(dest(), { ok: true });
    status = (await svc.deliveryStatusesFor(['d-1'])).get('d-1');
    expect(status).toMatchObject({ lastOk: true, lastErrorKind: null, consecutiveFailures: 0 });

    // A NEW streak notifies again.
    for (let i = 0; i < svc.DESTINATION_FAILURE_NOTIFY_THRESHOLD; i += 1) {
      await svc.recordDeliveryOutcome(dest(), { ok: false, kind: 'timeout' });
    }
    expect(sent).toHaveLength(2);
  });

  it('a never-attempted destination has no status', async () => {
    expect((await svc.deliveryStatusesFor(['nope'])).size).toBe(0);
  });

  it('publishes per-channel org counts, so one failing tenant of many is a ratio, not a page', async () => {
    await svc.recordDeliveryOutcome(dest('a', { orgId: 'org-a' }), { ok: false, kind: 'rejected' });
    await svc.recordDeliveryOutcome(dest('b', { orgId: 'org-b' }), { ok: true });
    await svc.recordDeliveryOutcome(dest('c', { orgId: 'org-c' }), { ok: true });
    // Same org, two destinations, one failing → the org counts once, as failing.
    await svc.recordDeliveryOutcome(dest('c2', { orgId: 'org-c', channel: 'webhook' }), { ok: false, kind: 'timeout' });
    await svc.recordDeliveryOutcome(dest('c3', { orgId: 'org-c', channel: 'webhook' }), { ok: true });
    // Out of the window: not counted.
    await svc.recordDeliveryOutcome(dest('old', { orgId: 'org-old' }), { ok: false, kind: 'rejected' }, new Date(Date.now() - 2 * 3_600_000));

    const out = await svc.publishDeliveryHealth();
    expect(out.slack).toEqual({ attempted: 3, failing: 1 });
    expect(out.webhook).toEqual({ attempted: 1, failing: 1 });
    expect(gauges.get('alert_destination_orgs{slack,failing}')).toBe(1);
    expect(gauges.get('alert_destination_orgs{slack,attempted}')).toBe(3);
    // Every known channel is published, so a recovered one reads zero.
    expect(gauges.get('alert_destination_orgs{email,failing}')).toBe(0);
  });

  it('expires a status nothing has tried for 30 days (TTL), keeping it out of the org cascade', async () => {
    const idx = (await m.AlertDestinationStatus.collection.indexes())
      .find((i: { key: Record<string, number> }) => i.key.lastAttemptAt === 1);
    expect(idx?.expireAfterSeconds).toBe(30 * 86_400);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI assistant usage report against a REAL MongoDB (mongodb-memory-server):
 * the `$facet` / `$dateTrunc` pipelines the unit suite can only check the shape
 * of. Proves the tz / weekStart bucketing, the own-org vs rollup scope, the
 * caller-type fold, the acceptance join, that the ledger's `calls` count is
 * what the report reads, and that the units match "What used this".
 *
 * Gated behind RUN_MONGO_INTEGRATION (skipped locally, REQUIRED on CI).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite, MONGOD_VERSION } from './helpers/integration-gate.js';

const suite = integrationSuite();

suite('AI usage report (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mongoose: any, UsageBucket: any, AiDraftOutcomeBucket: any, Organization: any;
  let report: any;
  let ledger: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(mongod.getUri());
    ({ UsageBucket } = await import('../src/models/usage-bucket.js'));
    ({ AiDraftOutcomeBucket } = await import('../src/models/ai-draft-outcome.js'));
    ({ Organization } = await import('../src/models/organization.js'));
    await Promise.all([UsageBucket.init(), AiDraftOutcomeBucket.init()]);
    report = await import('../src/services/ai-usage-report.js');
    ledger = await import('../src/services/usage-ledger.js');
  }, 180_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  beforeEach(async () => {
    await Promise.all([UsageBucket.deleteMany({}), AiDraftOutcomeBucket.deleteMany({}), Organization.collection.deleteMany({})]);
  });

  /** One aiCalls bucket row as the ledger writes it. */
  const bucket = (o: Record<string, unknown>) => ({
    quotaType: 'aiCalls',
    outcome: 'counted',
    principalType: null,
    principalId: null,
    keyId: null,
    route: null,
    pipelineId: null,
    feature: null,
    model: null,
    keySource: null,
    amount: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...o,
  });

  const q = (o: Record<string, unknown> = {}) => ({
    orgId: 'root',
    rollup: false,
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-10-20T00:00:00Z'),
    interval: 'day',
    tz: 'UTC',
    weekStart: 'monday',
    ...o,
  });

  it('buckets by the viewer\'s timezone: 03:00Z on Oct 6 is still Oct 5 in Chicago', async () => {
    await UsageBucket.collection.insertMany([
      bucket({ orgId: 'root', rootOrgId: 'root', hour: new Date('2026-10-06T03:00:00Z'), amount: 1, calls: 1, principalType: 'user', principalId: 'u-1', feature: 'ask' }),
      bucket({ orgId: 'root', rootOrgId: 'root', hour: new Date('2026-10-06T15:00:00Z'), amount: 2, calls: 2, principalType: 'user', principalId: 'u-2', feature: 'ask' }),
    ]);
    const utc = await report.queryAiUsageReport(q());
    expect(utc.buckets.map((b: any) => [b.bucket, b.calls])).toEqual([['2026-10-06', 3]]);
    const chicago = await report.queryAiUsageReport(q({ tz: 'America/Chicago' }));
    expect(chicago.buckets.map((b: any) => [b.bucket, b.calls])).toEqual([['2026-10-05', 1], ['2026-10-06', 2]]);
  });

  it('weeks start on the viewer\'s weekStart (Sunday Oct 11 opens a week, or closes one)', async () => {
    await UsageBucket.collection.insertMany([
      bucket({ orgId: 'root', rootOrgId: 'root', hour: new Date('2026-10-11T12:00:00Z'), amount: 1, calls: 1 }),
      bucket({ orgId: 'root', rootOrgId: 'root', hour: new Date('2026-10-12T12:00:00Z'), amount: 1, calls: 1 }),
    ]);
    const monday = await report.queryAiUsageReport(q({ interval: 'week', weekStart: 'monday' }));
    expect(monday.buckets.map((b: any) => [b.bucket, b.calls])).toEqual([['2026-10-05', 1], ['2026-10-12', 1]]);
    const sunday = await report.queryAiUsageReport(q({ interval: 'week', weekStart: 'sunday' }));
    expect(sunday.buckets.map((b: any) => [b.bucket, b.calls])).toEqual([['2026-10-11', 2]]);
  });

  it('own org vs rollup: a team\'s usage appears only in the rollup, by team name; caller types fold; no person in the report', async () => {
    const team = new mongoose.Types.ObjectId();
    await Organization.collection.insertOne({ _id: team, name: 'Payments', slug: 'payments', tier: 'pro', parentOrgId: 'root' });
    const teamId = team.toHexString();
    const hour = new Date('2026-10-03T10:00:00Z');
    await UsageBucket.collection.insertMany([
      bucket({ orgId: 'root', rootOrgId: 'root', hour, amount: 2, calls: 2, principalType: 'user', principalId: 'alice@example.com', feature: 'agent' }),
      bucket({ orgId: teamId, rootOrgId: 'root', hour, amount: 3, calls: 3, principalType: 'service_account', principalId: 'sa-1', keyId: 'k-1', feature: 'agent-tool:propose_pipeline' }),
      bucket({ orgId: teamId, rootOrgId: 'root', hour, amount: 1, calls: 1, principalType: 'service', principalId: 'reporting', feature: 'report-summary' }),
      bucket({ orgId: teamId, rootOrgId: 'root', hour, amount: 1, outcome: 'refunded', principalType: 'service', principalId: 'reporting', feature: 'report-summary' }),
      // Another account entirely — never in scope.
      bucket({ orgId: 'other', rootOrgId: 'other', hour, amount: 9, calls: 9, principalType: 'user', principalId: 'u-x' }),
      // Another quota — never in scope.
      bucket({ orgId: 'root', rootOrgId: 'root', hour, quotaType: 'apiCalls', amount: 50 }),
    ]);

    const own = await report.queryAiUsageReport(q());
    expect(own.totals).toMatchObject({ calls: 2, units: 2 });
    expect(own.byTeam).toBeNull();

    const rolled = await report.queryAiUsageReport(q({ rollup: true }));
    expect(rolled.totals).toMatchObject({ calls: 6, units: 5 });
    expect(rolled.byCallerType).toEqual([
      { callerType: 'user', calls: 2, units: 2, tokensIn: 0, tokensOut: 0 },
      { callerType: 'service_account', calls: 3, units: 3, tokensIn: 0, tokensOut: 0 },
      { callerType: 'system', calls: 1, units: 0, tokensIn: 0, tokensOut: 0 },
    ]);
    expect(rolled.byTeam).toEqual([
      { orgId: teamId, name: 'Payments', calls: 4, units: 3, tokensIn: 0, tokensOut: 0 },
      { orgId: 'root', name: null, calls: 2, units: 2, tokensIn: 0, tokensOut: 0 },
    ]);
    expect(rolled.byFeature.map((f: any) => [f.feature, f.calls])).toEqual([['agent', 2], ['agent-tool', 3], ['report-summary', 1]]);
    const text = JSON.stringify(rolled) + report.aiUsageReportToCsv(rolled);
    for (const person of ['alice@example.com', 'sa-1', 'k-1', 'u-x']) expect(text).not.toContain(person);

    // Units are the same net "What used this" reports for aiCalls over the same scope.
    const usage = await ledger.queryUsage({ orgId: 'root', quotaType: 'aiCalls', from: q().from, to: q().to, groupBy: 'feature' });
    expect(usage.reduce((s: number, g: any) => s + g.net, 0)).toBe(rolled.totals.units);
  });

  it('acceptance: outcomes recorded through recordDraftOutcome join per bucket and feature; acceptanceSince marks the first', async () => {
    await report.recordDraftOutcome({ orgId: 'root', rootOrgId: 'root', feature: 'pipeline-generate', outcome: 'accepted' });
    await report.recordDraftOutcome({ orgId: 'root', rootOrgId: 'root', feature: 'pipeline-generate', outcome: 'accepted' });
    await report.recordDraftOutcome({ orgId: 'root', rootOrgId: 'root', feature: 'pipeline-generate', outcome: 'discarded' });
    await report.recordDraftOutcome({ orgId: 'root', rootOrgId: 'root', feature: 'agent', outcome: 'edited_accepted' });
    // One bucket document per (org, hour, feature, outcome): the counter, not a row per event.
    expect(await AiDraftOutcomeBucket.countDocuments({})).toBe(3);
    const stored = await AiDraftOutcomeBucket.collection.findOne({ outcome: 'accepted' });
    expect(Object.keys(stored).sort()).toEqual(['_id', 'count', 'feature', 'hour', 'orgId', 'outcome', 'rootOrgId']);

    const now = new Date();
    const r = await report.queryAiUsageReport(q({ from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 3_600_000) }));
    expect(r.totals).toMatchObject({ accepted: 2, editedAccepted: 1, discarded: 1, outcomes: 4, acceptanceRate: 0.75 });
    expect(r.byFeature.find((f: any) => f.feature === 'pipeline-generate')).toMatchObject({ accepted: 2, discarded: 1 });
    expect(r.byFeature.find((f: any) => f.feature === 'agent')).toMatchObject({ editedAccepted: 1, acceptanceRate: 1 });
    expect(r.buckets.reduce((s: number, b: any) => s + b.outcomes, 0)).toBe(4);
    expect(r.acceptanceSince).not.toBeNull();

    // An older range: usage only, but acceptanceSince still says when tracking began.
    const old = await report.queryAiUsageReport(q());
    expect(old.totals.outcomes).toBe(0);
    expect(old.acceptanceSince).toBe(r.acceptanceSince);
  });

  it('the ledger counts one call per usage report — the number the report reads', async () => {
    const before = new Date(Date.now() - 3_600_000);
    ledger.recordUsage([
      { orgId: 'root', rootOrgId: 'root', quotaType: 'aiCalls', amount: 1, outcome: 'counted', attribution: { principalType: 'user', principalId: 'u', feature: 'ask' } },
    ]);
    for (let i = 0; i < 2; i++) {
      ledger.recordUsage([{ orgId: 'root', rootOrgId: 'root', quotaType: 'aiCalls', amount: 0, outcome: 'counted', report: true, tokensIn: 10, tokensOut: 5, attribution: { principalType: 'user', principalId: 'u', feature: 'ask' } }]);
    }
    // recordUsage is fire-and-forget; wait for the upserts to land.
    for (let i = 0; i < 50 && (await UsageBucket.countDocuments({ calls: 2 })) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const r = await report.queryAiUsageReport(q({ from: before, to: new Date(Date.now() + 3_600_000) }));
    expect(r.totals).toMatchObject({ calls: 2, units: 1, tokensIn: 20, tokensOut: 10 });
  });
});

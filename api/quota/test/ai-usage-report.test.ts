// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI assistant usage report (services/ai-usage-report.ts): the pipelines it
 * builds over the usage ledger and the draft-outcome buckets (scope, time
 * bounds, tz/week bucketing), how it folds the grouped rows into the report
 * (feature catalog, caller types, team names, acceptance rate), the
 * draft-outcome write, and the CSV. The aggregation itself runs against a real
 * mongod in ai-usage-report.integration.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const usageAggregate = jest.fn<AnyFn>();
const outcomeAggregate = jest.fn<AnyFn>();
const outcomeUpdateOne = jest.fn<AnyFn>();
const outcomeFindOne = jest.fn<AnyFn>();
const orgFind = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/usage-bucket.js', () => ({ UsageBucket: { aggregate: usageAggregate } }));
jest.unstable_mockModule('../src/models/ai-draft-outcome.js', () => ({
  AiDraftOutcomeBucket: {
    aggregate: outcomeAggregate,
    updateOne: outcomeUpdateOne,
    findOne: (...a: unknown[]) => ({ sort: () => ({ select: () => ({ lean: () => outcomeFindOne(...a) }) }) }),
  },
}));
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { find: (...a: unknown[]) => ({ select: () => ({ lean: () => orgFind(...a) }) }) },
}));
jest.unstable_mockModule('../src/config.js', () => ({ config: { quota: { usageEventRetentionDays: 90 } } }));

const {
  AI_DRAFT_OUTCOMES, AI_REPORT_FEATURES, reportFeatureOf, recordDraftOutcome, queryAiUsageReport, aiUsageReportToCsv, acceptanceRate,
} = await import('../src/services/ai-usage-report.js');

const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-10-15T00:00:00Z');
const base = { orgId: 'root', from, to, interval: 'day' as const, tz: 'America/Chicago', weekStart: 'monday' as const };

const sums = (calls: number, counted: number, refunded = 0, tokensIn = 0, tokensOut = 0) => ({ calls, counted, refunded, tokensIn, tokensOut });

beforeEach(() => {
  jest.clearAllMocks();
  usageAggregate.mockResolvedValue([{ totals: [], buckets: [], callers: [], features: [], teams: [] }]);
  outcomeAggregate.mockResolvedValue([{ totals: [], buckets: [], features: [] }]);
  outcomeFindOne.mockResolvedValue(null);
  orgFind.mockResolvedValue([]);
  outcomeUpdateOne.mockResolvedValue({});
});

describe('catalogs', () => {
  it('the outcome catalog is bounded to the three draft outcomes', () => {
    expect(AI_DRAFT_OUTCOMES).toEqual(['accepted', 'edited_accepted', 'discarded']);
  });

  it('folds a raw ledger feature onto the keyed report catalog — agent tools collapse, unknown or missing is "other"', () => {
    expect(reportFeatureOf('ask')).toBe('ask');
    expect(reportFeatureOf('agent-tool:propose_pipeline')).toBe('agent-tool');
    expect(reportFeatureOf('report-summary')).toBe('report-summary');
    expect(reportFeatureOf('build:manual:standard:1x')).toBe('other');
    expect(reportFeatureOf(null)).toBe('other');
    expect(Object.keys(AI_REPORT_FEATURES)).toContain('other');
  });

  it('acceptance rate counts edited-then-accepted as accepted, and is null with no outcomes', () => {
    expect(acceptanceRate({ accepted: 2, editedAccepted: 1, discarded: 1 })).toBe(0.75);
    expect(acceptanceRate({ accepted: 0, editedAccepted: 0, discarded: 0 })).toBeNull();
  });
});

describe('recordDraftOutcome', () => {
  it('upserts the hourly (org, feature, outcome) bucket by $inc — no user, no content', async () => {
    await recordDraftOutcome({ orgId: 'team-a', rootOrgId: 'root', feature: 'pipeline-generate', outcome: 'edited_accepted' });
    const [filter, update, opts] = outcomeUpdateOne.mock.calls[0] as [Record<string, unknown>, Record<string, any>, unknown];
    expect(filter).toEqual({ orgId: 'team-a', hour: expect.any(Date), feature: 'pipeline-generate', outcome: 'edited_accepted' });
    expect((filter.hour as Date).getUTCMinutes()).toBe(0);
    expect(update).toEqual({ $inc: { count: 1 }, $set: { rootOrgId: 'root' } });
    expect(opts).toEqual({ upsert: true });
  });
});

describe('queryAiUsageReport', () => {
  it('own-org scope: matches orgId only, aiCalls only, the hour range, and buckets by the viewer\'s tz', async () => {
    await queryAiUsageReport({ ...base, rollup: false });
    const [pipeline] = usageAggregate.mock.calls[0] as [Array<Record<string, any>>];
    expect(pipeline[0]!.$match).toEqual({ orgId: 'root', quotaType: 'aiCalls', hour: { $gte: from, $lt: to } });
    const facet = pipeline[1]!.$facet;
    expect(facet.teams).toBeUndefined();
    const bucketKey = facet.buckets[0].$group._id;
    expect(bucketKey).toEqual({
      $dateToString: { format: '%Y-%m-%d', timezone: 'America/Chicago', date: { $dateTrunc: { date: '$hour', unit: 'day', timezone: 'America/Chicago' } } },
    });
    const [outcomePipeline] = outcomeAggregate.mock.calls[0] as [Array<Record<string, any>>];
    expect(outcomePipeline[0]!.$match).toEqual({ orgId: 'root', hour: { $gte: from, $lt: to } });
  });

  it('rollup scope: the account (root ∪ own) and a per-team facet; weeks honour weekStart', async () => {
    await queryAiUsageReport({ ...base, rollup: true, interval: 'week', weekStart: 'sunday' });
    const [pipeline] = usageAggregate.mock.calls[0] as [Array<Record<string, any>>];
    expect(pipeline[0]!.$match.$or).toEqual([{ rootOrgId: 'root' }, { orgId: 'root' }]);
    expect(pipeline[1]!.$facet.teams[0].$group._id).toBe('$orgId');
    expect(pipeline[1]!.$facet.buckets[0].$group._id.$dateToString.date.$dateTrunc).toEqual({
      date: '$hour', unit: 'week', timezone: 'America/Chicago', startOfWeek: 'sunday',
    });
  });

  it('folds the facets into the report: net units, caller types, features, teams by name, acceptance per bucket and feature', async () => {
    usageAggregate.mockResolvedValue([{
      totals: [{ _id: null, ...sums(9, 8, 1, 900, 300) }],
      buckets: [
        { _id: '2026-10-02', ...sums(5, 5, 0, 500, 100) },
        { _id: '2026-10-01', ...sums(4, 3, 1, 400, 200) },
      ],
      callers: [
        { _id: 'user', ...sums(6, 6) },
        { _id: 'service_account', ...sums(2, 1) },
        { _id: 'system', ...sums(1, 1) },
      ],
      features: [
        { _id: 'agent', ...sums(3, 3) },
        { _id: 'agent-tool:propose_pipeline', ...sums(2, 2) },
        { _id: 'agent-tool:propose_plugin', ...sums(1, 1) },
        { _id: 'pipeline-generate', ...sums(3, 2, 1) },
      ],
      teams: [
        { _id: 'root', ...sums(4, 4) },
        { _id: 'team-a', ...sums(5, 4, 1) },
      ],
    }]);
    outcomeAggregate.mockResolvedValue([{
      totals: [{ _id: 'accepted', n: 2 }, { _id: 'edited_accepted', n: 1 }, { _id: 'discarded', n: 1 }],
      buckets: [
        { _id: { b: '2026-10-01', o: 'accepted' }, n: 2 },
        { _id: { b: '2026-10-03', o: 'discarded' }, n: 1 },
        { _id: { b: '2026-10-03', o: 'edited_accepted' }, n: 1 },
      ],
      features: [
        { _id: { f: 'pipeline-generate', o: 'accepted' }, n: 2 },
        { _id: { f: 'pipeline-generate', o: 'discarded' }, n: 1 },
        { _id: { f: 'agent', o: 'edited_accepted' }, n: 1 },
      ],
    }]);
    outcomeFindOne.mockResolvedValue({ hour: new Date('2026-09-20T10:00:00Z') });
    orgFind.mockResolvedValue([{ _id: 'team-a', name: 'Team A' }]);

    const r = await queryAiUsageReport({ ...base, rollup: true });

    expect(r.totals).toEqual({ calls: 9, units: 7, tokensIn: 900, tokensOut: 300, accepted: 2, editedAccepted: 1, discarded: 1, outcomes: 4, acceptanceRate: 0.75 });
    // Union of usage and outcome buckets, in order; a bucket with outcomes but no calls still shows.
    expect(r.buckets.map((b) => b.bucket)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(r.buckets[0]).toMatchObject({ calls: 4, units: 2, accepted: 2, acceptanceRate: 1 });
    expect(r.buckets[1]).toMatchObject({ calls: 5, outcomes: 0, acceptanceRate: null });
    expect(r.buckets[2]).toMatchObject({ calls: 0, editedAccepted: 1, discarded: 1, acceptanceRate: 0.5 });
    expect(r.byCallerType).toEqual([
      { callerType: 'user', calls: 6, units: 6, tokensIn: 0, tokensOut: 0 },
      { callerType: 'service_account', calls: 2, units: 1, tokensIn: 0, tokensOut: 0 },
      { callerType: 'system', calls: 1, units: 1, tokensIn: 0, tokensOut: 0 },
    ]);
    const agentTool = r.byFeature.find((f) => f.feature === 'agent-tool')!;
    expect(agentTool).toMatchObject({ calls: 3, units: 3, outcomes: 0, acceptanceRate: null });
    expect(r.byFeature.find((f) => f.feature === 'pipeline-generate')).toMatchObject({ calls: 3, units: 1, accepted: 2, discarded: 1, acceptanceRate: 2 / 3 });
    expect(r.byFeature.find((f) => f.feature === 'agent')).toMatchObject({ editedAccepted: 1, acceptanceRate: 1 });
    // Largest first; a team without a readable name keeps its id.
    expect(r.byTeam).toEqual([
      { orgId: 'team-a', name: 'Team A', calls: 5, units: 3, tokensIn: 0, tokensOut: 0 },
      { orgId: 'root', name: null, calls: 4, units: 4, tokensIn: 0, tokensOut: 0 },
    ]);
    expect(r).toMatchObject({ orgId: 'root', scope: 'rollup', interval: 'day', tz: 'America/Chicago', weekStart: 'monday', retentionDays: 90, acceptanceSince: '2026-09-20T10:00:00.000Z' });
  });

  it('never carries a person: no principal id reaches any pipeline or row', async () => {
    await queryAiUsageReport({ ...base, rollup: true });
    const text = JSON.stringify([usageAggregate.mock.calls, outcomeAggregate.mock.calls]);
    expect(text).not.toContain('principalId');
    expect(text).not.toContain('keyId');
  });

  it('an empty range reports zeros, no team facet without rollup, and no acceptance start', async () => {
    usageAggregate.mockResolvedValue([]);
    outcomeAggregate.mockResolvedValue([]);
    const r = await queryAiUsageReport({ ...base, rollup: false });
    expect(r.totals).toEqual({ calls: 0, units: 0, tokensIn: 0, tokensOut: 0, accepted: 0, editedAccepted: 0, discarded: 0, outcomes: 0, acceptanceRate: null });
    expect(r.buckets).toEqual([]);
    expect(r.byTeam).toBeNull();
    expect(r.acceptanceSince).toBeNull();
    expect(r.scope).toBe('org');
    expect(orgFind).not.toHaveBeenCalled();
  });
});

describe('aiUsageReportToCsv', () => {
  it('one row per bucket, caller type, team and feature, with the formula guard', async () => {
    usageAggregate.mockResolvedValue([{
      totals: [{ _id: null, ...sums(2, 2) }],
      buckets: [{ _id: '2026-10-01', ...sums(2, 2, 0, 10, 5) }],
      callers: [{ _id: 'user', ...sums(2, 2) }],
      features: [{ _id: 'ask', ...sums(2, 2) }],
      teams: [{ _id: 'team-a', ...sums(2, 2) }],
    }]);
    outcomeAggregate.mockResolvedValue([{ totals: [], buckets: [], features: [{ _id: { f: 'ask', o: 'discarded' }, n: 1 }] }]);
    orgFind.mockResolvedValue([{ _id: 'team-a', name: '=HYPERLINK("x")' }]);
    const csv = aiUsageReportToCsv(await queryAiUsageReport({ ...base, rollup: true }));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('section,key,label,calls,units,tokensIn,tokensOut,accepted,editedAccepted,discarded,acceptanceRate');
    expect(lines).toContain('bucket,2026-10-01,2026-10-01,2,2,10,5,0,0,0,');
    expect(lines).toContain('caller_type,user,User sessions,2,2,0,0,,,,');
    expect(lines).toContain('team,team-a,"\'=HYPERLINK(""x"")",2,2,0,0,,,,');
    expect(lines).toContain('feature,ask,Ask (how-to answers),2,2,0,0,0,0,1,0');
  });
});

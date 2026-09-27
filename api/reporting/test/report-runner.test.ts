// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared run executor.
 *
 * This is the part the on-demand route and the scheduler have in common, so the tests are
 * about the invariants that must hold WHICHEVER of them called:
 *
 *  - A PERIOD THE DATA CANNOT SUPPORT IS REFUSED with the reason, never silently
 *    truncated. A report labelled 2026-Q1 that quietly covers its last 30 days is worse
 *    than no report, because nobody can tell.
 *  - A RUN THAT ALREADY HAS A SNAPSHOT IS REUSED. The numbers in a frozen snapshot do not
 *    change, so recomputing could only produce a different answer — the thing the freeze
 *    exists to prevent.
 *  - A FAILED COMPOSE LEAVES THE ROW, marked failed with the reason, so the lead sees WHY
 *    a report is missing rather than a gap in the history.
 *  - REGENERATING SUPERSEDES rather than overwriting, so a manager who read v1 can still
 *    see exactly what they read.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockCompose = jest.fn<AnyFn>();
const mockResolvePeriod = jest.fn<AnyFn>();
const mockResolveByLabel = jest.fn<AnyFn>();
const mockReject = jest.fn<AnyFn>();
const mockRetention = jest.fn<AnyFn>();
const mockPosture = jest.fn<AnyFn>();

const store = {
  createRun: jest.fn<AnyFn>(),
  nextVersion: jest.fn<AnyFn>(),
  completeRun: jest.fn<AnyFn>(),
  failRun: jest.fn<AnyFn>(),
  supersede: jest.fn<AnyFn>(),
  listRuns: jest.fn<AnyFn>(),
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: { marker: 'the-real-source' },
  stakeholderReportStore: store,
  composeSnapshot: (...a: unknown[]) => mockCompose(...a),
  resolvePeriod: (...a: unknown[]) => mockResolvePeriod(...a),
  resolvePeriodByLabel: (...a: unknown[]) => mockResolveByLabel(...a),
  rejectUnreportablePeriod: (...a: unknown[]) => mockReject(...a),
}));

jest.unstable_mockModule('../src/helpers/retention-cap.js', () => ({
  resolveOrgRetentionWindow: (...a: unknown[]) => mockRetention(...a),
  retentionOrgIdFor: () => 'acme',
}));

jest.unstable_mockModule('../src/services/report-posture.js', () => ({
  readPosture: (...a: unknown[]) => mockPosture(...a),
}));

const { composeRun, reportDataSource, resolveRunPeriod } = await import('../src/services/report-runner.js');

const PERIOD = {
  start: new Date('2026-09-14T05:00:00.000Z'),
  end: new Date('2026-09-21T05:00:00.000Z'),
  prevStart: new Date('2026-09-07T05:00:00.000Z'),
  prevEnd: new Date('2026-09-14T05:00:00.000Z'),
  label: '2026-W38',
};

const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1',
  orgId: 'acme',
  ownerId: 'user-lead',
  name: 'Weekly delivery',
  cadence: 'weekly',
  timezone: 'America/Chicago',
  weekStart: 'monday',
  scope: { kind: 'org' },
  sections: ['success_rate'],
  ...over,
}) as never;

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1', orgId: 'acme', definitionId: 'def-1', version: 1, snapshot: null, periodLabel: '2026-W38', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolvePeriod.mockReturnValue(PERIOD);
  mockResolveByLabel.mockReturnValue(PERIOD);
  mockReject.mockReturnValue(null);
  mockRetention.mockResolvedValue({ minFromMs: 0 });
  mockCompose.mockResolvedValue({ sections: [], period: {} });
  store.createRun.mockResolvedValue({ run: run(), created: true });
  store.completeRun.mockResolvedValue(run({ snapshot: { sections: [] } }));
  store.nextVersion.mockResolvedValue(2);
  store.failRun.mockResolvedValue(undefined);
  store.supersede.mockResolvedValue(undefined);
  store.listRuns.mockResolvedValue([]);
});

describe('resolveRunPeriod', () => {
  it('resolves the last complete period when no label is given', async () => {
    const result = await resolveRunPeriod({ definition: definition(), features: [] });
    expect(result).toMatchObject({ period: PERIOD });
    expect(mockResolvePeriod).toHaveBeenCalled();
  });

  it('resolves a named period by label', async () => {
    await resolveRunPeriod({ definition: definition(), periodLabel: '2026-W37', features: [] });
    expect(mockResolveByLabel).toHaveBeenCalledWith('2026-W37', 'weekly', 'America/Chicago', 'monday');
  });

  it('refuses an unparseable label with the format it wanted', async () => {
    mockResolveByLabel.mockReturnValue(null);
    const result = await resolveRunPeriod({ definition: definition(), periodLabel: '2026-W99', features: [] });
    expect(result).toMatchObject({ refusal: { kind: 'bad_period' } });
    // The message has to say what a valid label looks like: this is a typo, and the caller
    // can fix it.
    expect((result as { refusal: { message: string } }).refusal.message).toContain('2026-W38');
  });

  it('refuses a period past the retention horizon, with the reason', async () => {
    mockReject.mockReturnValue({ reason: 'before_retention', message: 'the underlying events have been purged' });
    const result = await resolveRunPeriod({ definition: definition(), features: [] });
    expect(result).toMatchObject({ refusal: { kind: 'unreportable' } });
    expect((result as { refusal: { message: string } }).refusal.message).toContain('purged');
  });

  it('includes the PREVIOUS period in the retention check', async () => {
    await resolveRunPeriod({ definition: definition(), features: [] });
    // The comparison period is part of the report whenever a section shows change, so its
    // start is the real floor — otherwise "vs last week" silently reads zero.
    expect(mockReject.mock.calls[0]?.[1]).toMatchObject({ includePrevious: true });
  });

  it('resolves retention against the account ROOT when one is given', async () => {
    await resolveRunPeriod({ definition: definition(), features: [], retentionOrgId: 'root-org' });
    // A team's window is the root's: retention is a billing entitlement synced onto the
    // root only.
    expect(mockRetention).toHaveBeenCalledWith('acme', 'event', 'root-org');
  });

  it('falls back to the definition own org when no root is given', async () => {
    await resolveRunPeriod({ definition: definition(), features: [] });
    expect(mockRetention).toHaveBeenCalledWith('acme', 'event', 'acme');
  });
});

describe('composeRun', () => {
  it('composes, freezes and returns the run', async () => {
    const result = await composeRun({ definition: definition(), features: ['stakeholder_reports'] });
    expect(result).toMatchObject({ ok: true, reused: false });
    expect(store.completeRun).toHaveBeenCalledWith('acme', 'run-1', { sections: [], period: {} });
  });

  it('passes the definition\'s timezone, week start and features to the composer', async () => {
    await composeRun({ definition: definition(), features: ['stakeholder_reports'] });
    expect(mockCompose.mock.calls[0]?.[1]).toMatchObject({
      timezone: 'America/Chicago',
      weekStart: 'monday',
      orgId: 'acme',
      features: ['stakeholder_reports'],
    });
  });

  it('passes a rollup\'s org set through', async () => {
    await composeRun({ definition: definition(), features: [], orgIds: ['acme', 'team-1'] });
    expect(mockCompose.mock.calls[0]?.[1]).toMatchObject({ orgIds: ['acme', 'team-1'] });
  });

  it('REUSES a period that already has a snapshot', async () => {
    store.createRun.mockResolvedValue({ run: run({ snapshot: { sections: [] } }), created: false });
    const result = await composeRun({ definition: definition(), features: [] });
    expect(result).toMatchObject({ ok: true, reused: true });
    // Recomputing could only produce a different answer, which is what the freeze prevents.
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('recomputes an existing run that has NO snapshot', async () => {
    store.createRun.mockResolvedValue({ run: run({ snapshot: null }), created: false });
    const result = await composeRun({ definition: definition(), features: [] });
    // A run row with no snapshot is an interrupted attempt, not a frozen report.
    expect(result).toMatchObject({ reused: false });
    expect(mockCompose).toHaveBeenCalled();
  });

  it('asks for the next VERSION when regenerating, and supersedes the one it replaces', async () => {
    store.createRun.mockResolvedValue({ run: run({ version: 2 }), created: true });
    store.completeRun.mockResolvedValue(run({ id: 'run-2', version: 2 }));
    store.listRuns.mockResolvedValue([run({ id: 'run-1', version: 1, periodLabel: '2026-W38' })]);
    await composeRun({ definition: definition(), features: [], regenerate: true });
    expect(store.nextVersion).toHaveBeenCalledWith('def-1', PERIOD.start);
    // Points the old row at the new one rather than overwriting it, so a manager who read
    // v1 can still see exactly what they read.
    expect(store.supersede).toHaveBeenCalledWith('acme', 'run-1', 'run-2');
  });

  it('does not supersede when there is no prior version to point at', async () => {
    store.createRun.mockResolvedValue({ run: run({ version: 2 }), created: true });
    store.listRuns.mockResolvedValue([]);
    await composeRun({ definition: definition(), features: [], regenerate: true });
    expect(store.supersede).not.toHaveBeenCalled();
  });

  it('marks the run FAILED and returns the refusal when the composer throws', async () => {
    mockCompose.mockRejectedValue(new Error('statement timeout'));
    const result = await composeRun({ definition: definition(), features: [] });
    expect(result).toMatchObject({ ok: false, refusal: { kind: 'compose_failed' } });
    // The row stays, so the lead sees WHY a report is missing instead of a gap discovered
    // by a manager asking where it went.
    expect(store.failRun).toHaveBeenCalledWith('acme', 'run-1', expect.stringContaining('could not be computed'));
  });

  it('creates no run at all for a refused period', async () => {
    mockReject.mockReturnValue({ reason: 'in_progress', message: 'has not finished yet' });
    const result = await composeRun({ definition: definition(), features: [] });
    expect(result).toMatchObject({ ok: false });
    // No row, because there is nothing to report and a failed row would imply there was.
    expect(store.createRun).not.toHaveBeenCalled();
  });
});

describe('reportDataSource', () => {
  it('is the reporting service PLUS the posture read', async () => {
    const source = reportDataSource('acme') as unknown as Record<string, unknown>;
    expect(source.marker).toBe('the-real-source');
    expect(typeof source.getCompliancePosture).toBe('function');
  });

  it('scopes the posture read to the definition\'s org and the section\'s window', async () => {
    mockPosture.mockResolvedValue({ compliance: null, access: null });
    const source = reportDataSource('acme') as unknown as {
      getCompliancePosture: (s: { from: string; to: string }) => Promise<unknown>;
    };
    await source.getCompliancePosture({ from: 'a', to: 'b' });
    expect(mockPosture).toHaveBeenCalledWith('acme', 'a', 'b');
  });
});

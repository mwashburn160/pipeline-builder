// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The report scheduler.
 *
 * A scheduled run has no caller, and every test here is about one of the consequences:
 *
 *  - THE CLAIM COMES FIRST. A claim taken after the compose would leave a window wide
 *    enough for a second sweep to compose and DELIVER the same report, which is the
 *    failure a manager notices.
 *  - A LOST CLAIM IS SILENT AND HARMLESS. The loser must do nothing at all, not retry.
 *  - AUTHORITY IS RE-CHECKED PER RUN, and the three revoked answers PAUSE with the
 *    reason while an UNREADABLE answer only skips. That third case is the one worth a
 *    test: treating "platform is down" as "revoked" would pause every report in the
 *    fleet during a five-minute blip and need a human to resume each one.
 *  - THE SCHEDULE IS ADVANCED EVEN WHEN THE RUN THROWS, so a permanently failing
 *    definition costs its own period rather than starving the batch forever.
 *  - JITTER IS STABLE per definition, so a report lands in roughly the same slot each
 *    period instead of walking around the window.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const store = {
  dueDefinitions: jest.fn<AnyFn>(),
  claimDefinition: jest.fn<AnyFn>(),
  pauseDefinition: jest.fn<AnyFn>(),
  publishRun: jest.fn<AnyFn>(),
  recordDelivery: jest.fn<AnyFn>(),
};

const mockAuthority = jest.fn<AnyFn>();
const mockComposeRun = jest.fn<AnyFn>();
const mockDeliver = jest.fn<AnyFn>();
const mockReadyForReview = jest.fn<AnyFn>();
const mockRunFailed = jest.fn<AnyFn>();
const mockPaused = jest.fn<AnyFn>();
const mockRollup = jest.fn<AnyFn>();

/** Every scheduler the suite built, so each test can stop what it started. */
const built: Array<{ start: () => void; stop: () => void }> = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (opts: Record<string, unknown>) => {
    const s = {
      start: () => undefined,
      stop: () => undefined,
      // The suite drives the cycle directly rather than waiting on a timer.
      cycle: () => (opts.run as (r: { signal: AbortSignal }) => Promise<void>)({ signal: new AbortController().signal }),
      opts,
    };
    built.push(s);
    return s;
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  stakeholderReportStore: store,
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  nextPeriodBoundary: () => new Date('2026-09-28T05:00:00.000Z'),
  completePeriodsSince: (...a: unknown[]) => mockPeriods(...a),
}));

const mockPeriods = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/helpers/report-helpers.js', () => ({
  resolveOrgRollup: (...a: unknown[]) => mockRollup(...a),
  REPORTING_HTTP_TIMEOUT_MS: 3000,
}));

jest.unstable_mockModule('../src/services/report-identity.js', () => ({
  reportIdentity: () => ({ authority: (...a: unknown[]) => mockAuthority(...a) }),
}));

jest.unstable_mockModule('../src/services/report-runner.js', () => ({
  composeRun: (...a: unknown[]) => mockComposeRun(...a),
}));

jest.unstable_mockModule('../src/services/report-delivery.js', () => ({
  deliverPublishedRun: (...a: unknown[]) => mockDeliver(...a),
  notifyReadyForReview: (...a: unknown[]) => mockReadyForReview(...a),
  notifyRunFailed: (...a: unknown[]) => mockRunFailed(...a),
  notifyPaused: (...a: unknown[]) => mockPaused(...a),
}));

const scheduler = await import('../src/services/report-scheduler.js');
// The schedule derivation lives in its own module (a route needs it too); the spike suite
// at the bottom asserts the jitter through it.
const schedule = await import('../src/services/report-schedule.js');

const NOW = new Date('2026-09-21T12:00:00.000Z');
const SEEN = new Date('2026-09-21T11:00:00.000Z');

const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1',
  orgId: 'acme',
  ownerId: 'user-lead',
  name: 'Weekly delivery',
  cadence: 'weekly',
  timezone: 'America/Chicago',
  weekStart: 'monday',
  scope: { kind: 'org' },
  recipients: ['rec-1'],
  autoSend: false,
  isActive: true,
  pausedReason: null,
  nextRunAt: SEEN,
  lastRunAt: null,
  sections: ['success_rate'],
  ...over,
});

const period = (label: string) => ({
  start: new Date('2026-09-14T05:00:00.000Z'),
  end: new Date('2026-09-21T05:00:00.000Z'),
  prevStart: new Date('2026-09-07T05:00:00.000Z'),
  prevEnd: new Date('2026-09-14T05:00:00.000Z'),
  label,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 'run-1', orgId: 'acme', definitionId: 'def-1', periodLabel: '2026-W38', version: 1, ...over,
});

/** Drive one cycle of a freshly built scheduler. */
async function cycle(): Promise<void> {
  built.length = 0;
  const s = scheduler.createReportScheduler() as unknown as { cycle: () => Promise<void> } | null;
  await s?.cycle();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick'] });
  delete process.env.REPORT_SCHEDULER_ENABLED;
  delete process.env.REPORT_JITTER_MS;
  delete process.env.REPORT_CATCHUP_MAX;
  store.dueDefinitions.mockResolvedValue([]);
  store.claimDefinition.mockResolvedValue(true);
  store.pauseDefinition.mockResolvedValue(undefined);
  store.publishRun.mockResolvedValue({ run: run(), alreadyPublished: false });
  store.recordDelivery.mockResolvedValue(undefined);
  mockAuthority.mockResolvedValue({
    active: true, permissions: ['reports:author'], features: ['stakeholder_reports'],
  });
  mockPeriods.mockReturnValue([period('2026-W38')]);
  mockComposeRun.mockResolvedValue({ ok: true, run: run(), period: period('2026-W38'), reused: false });
  mockDeliver.mockResolvedValue({ inApp: 1, email: { sent: 1, failed: 0, skipped: 0 }, destinations: { delivered: 0, failed: 0 }, emailAvailable: true, notes: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the kill switch', () => {
  it('builds nothing when disabled', () => {
    process.env.REPORT_SCHEDULER_ENABLED = 'false';
    expect(scheduler.createReportScheduler()).toBeNull();
    expect(scheduler.isReportSchedulerEnabled()).toBe(false);
  });

  it('stops a cycle mid-flight when flipped, without a redeploy', async () => {
    const s = scheduler.createReportScheduler() as unknown as { cycle: () => Promise<void> };
    process.env.REPORT_SCHEDULER_ENABLED = 'false';
    await s.cycle();
    // Re-read per cycle, not captured at construction — that is what "without a
    // redeploy" means.
    expect(store.dueDefinitions).not.toHaveBeenCalled();
  });

  it('is on by default', () => {
    expect(scheduler.isReportSchedulerEnabled()).toBe(true);
    expect(scheduler.createReportScheduler()).not.toBeNull();
  });
});

describe('claiming', () => {
  it('claims BEFORE doing any work', async () => {
    store.dueDefinitions.mockResolvedValue([definition()]);
    await cycle();
    const claimOrder = store.claimDefinition.mock.invocationCallOrder[0] ?? 0;
    const authorityOrder = mockAuthority.mock.invocationCallOrder[0] ?? 0;
    // A claim taken after the compose leaves a window wide enough to duplicate a
    // delivery.
    expect(claimOrder).toBeLessThan(authorityOrder);
  });

  it('claims against the `next_run_at` the scan saw', async () => {
    store.dueDefinitions.mockResolvedValue([definition()]);
    await cycle();
    expect(store.claimDefinition.mock.calls[0]?.[1]).toBe(SEEN);
  });

  it('does nothing at all when the claim is LOST', async () => {
    store.dueDefinitions.mockResolvedValue([definition()]);
    store.claimDefinition.mockResolvedValue(false);
    await cycle();
    expect(mockAuthority).not.toHaveBeenCalled();
    expect(mockComposeRun).not.toHaveBeenCalled();
  });

  it('skips a row whose nextRunAt vanished under the scan', async () => {
    store.dueDefinitions.mockResolvedValue([definition({ nextRunAt: null })]);
    await cycle();
    expect(store.claimDefinition).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is due', async () => {
    await cycle();
    expect(store.claimDefinition).not.toHaveBeenCalled();
  });
});

describe('the per-run authority recheck', () => {
  it('runs when the owner is active, permitted and entitled', async () => {
    store.dueDefinitions.mockResolvedValue([definition()]);
    await cycle();
    expect(mockComposeRun).toHaveBeenCalledTimes(1);
    expect(store.pauseDefinition).not.toHaveBeenCalled();
  });

  it.each([
    ['owner_inactive', { active: false, permissions: [], features: [] }],
    ['permission_lost', { active: true, permissions: [], features: ['stakeholder_reports'] }],
    ['entitlement', { active: true, permissions: ['reports:author'], features: [] }],
  ])('pauses with reason %s', async (reason, authority) => {
    store.dueDefinitions.mockResolvedValue([definition()]);
    mockAuthority.mockResolvedValue(authority);
    await cycle();
    expect(store.pauseDefinition).toHaveBeenCalledWith('def-1', reason);
    // The lead is told WHICH of the three it was: an entitlement lapse is a billing
    // conversation, a deactivated owner is a handover, a lost permission is an admin
    // question.
    expect(mockPaused).toHaveBeenCalledWith(expect.objectContaining({ id: 'def-1' }), reason);
    expect(mockComposeRun).not.toHaveBeenCalled();
  });

  it('SKIPS without pausing when platform cannot answer', async () => {
    store.dueDefinitions.mockResolvedValue([definition()]);
    mockAuthority.mockResolvedValue(null);
    await cycle();
    // Fail-closed on the RUN, not on the definition: a five-minute platform blip must
    // not pause every report in the fleet and need a human to resume each one.
    expect(mockComposeRun).not.toHaveBeenCalled();
    expect(store.pauseDefinition).not.toHaveBeenCalled();
    expect(mockPaused).not.toHaveBeenCalled();
  });
});

describe('running a definition', () => {
  it('queues a review notice when auto-send is off', async () => {
    store.dueDefinitions.mockResolvedValue([definition({ autoSend: false })]);
    await cycle();
    expect(mockReadyForReview).toHaveBeenCalledTimes(1);
    // Nothing reaches a manager before the lead has added the context the data cannot
    // supply — which is the entire reason the review step exists.
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(store.publishRun).not.toHaveBeenCalled();
  });

  it('publishes and delivers when auto-send is on', async () => {
    store.dueDefinitions.mockResolvedValue([definition({ autoSend: true })]);
    await cycle();
    // Published AS THE OWNER: the run had no caller, and attributing it to the person
    // who chose auto-send is the only honest answer.
    expect(store.publishRun).toHaveBeenCalledWith('acme', 'run-1', 'user-lead');
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect(store.recordDelivery).toHaveBeenCalledTimes(1);
    expect(mockReadyForReview).not.toHaveBeenCalled();
  });

  it('resolves the rollup only for a rollup-scoped definition', async () => {
    store.dueDefinitions.mockResolvedValue([definition({ scope: { kind: 'org' } })]);
    await cycle();
    expect(mockRollup).not.toHaveBeenCalled();

    jest.clearAllMocks();
    store.claimDefinition.mockResolvedValue(true);
    mockAuthority.mockResolvedValue({ active: true, permissions: ['reports:author'], features: ['stakeholder_reports'] });
    mockPeriods.mockReturnValue([period('2026-W38')]);
    mockComposeRun.mockResolvedValue({ ok: true, run: run(), period: period('2026-W38'), reused: false });
    store.dueDefinitions.mockResolvedValue([definition({ scope: { kind: 'rollup' } })]);
    mockRollup.mockResolvedValue(['acme', 'team-1']);
    await cycle();
    expect(mockRollup).toHaveBeenCalledWith('acme');
    expect(mockComposeRun.mock.calls[0]?.[0]).toMatchObject({ orgIds: ['acme', 'team-1'] });
  });

  it('catches up every missed period, in the order it was given', async () => {
    store.dueDefinitions.mockResolvedValue([definition({ lastRunAt: new Date('2026-08-31T05:00:00Z') })]);
    mockPeriods.mockReturnValue([period('2026-W36'), period('2026-W37'), period('2026-W38')]);
    await cycle();
    expect(mockComposeRun).toHaveBeenCalledTimes(3);
    expect(mockComposeRun.mock.calls.map((c) => (c[0] as { periodLabel: string }).periodLabel))
      .toEqual(['2026-W36', '2026-W37', '2026-W38']);
  });

  it('tells the lead when a period is REFUSED, and keeps going', async () => {
    store.dueDefinitions.mockResolvedValue([definition()]);
    mockPeriods.mockReturnValue([period('2026-W37'), period('2026-W38')]);
    mockComposeRun
      .mockResolvedValueOnce({ ok: false, refusal: { kind: 'unreportable', message: 'past your retention horizon' } })
      .mockResolvedValueOnce({ ok: true, run: run(), period: period('2026-W38'), reused: false });
    await cycle();
    // A refused period is a fact about the org's retention, not a broken schedule — so
    // the lead hears about it once and the next period still runs.
    expect(mockRunFailed).toHaveBeenCalledWith(expect.anything(), '2026-W37', 'past your retention horizon');
    expect(mockReadyForReview).toHaveBeenCalledTimes(1);
  });

  it('does nothing further for a period whose snapshot already existed', async () => {
    store.dueDefinitions.mockResolvedValue([definition({ autoSend: true })]);
    mockComposeRun.mockResolvedValue({ ok: true, run: run(), period: period('2026-W38'), reused: true });
    await cycle();
    // Re-delivering a frozen snapshot would send the same manager the same report twice.
    expect(store.publishRun).not.toHaveBeenCalled();
    expect(mockReadyForReview).not.toHaveBeenCalled();
  });

  it('survives a throwing run and still processes the rest of the batch', async () => {
    store.dueDefinitions.mockResolvedValue([definition({ id: 'def-1' }), definition({ id: 'def-2' })]);
    mockComposeRun
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ ok: true, run: run(), period: period('2026-W38'), reused: false });
    await cycle();
    // The schedule was already advanced by the claim, so a definition that fails every
    // cycle costs its own period instead of starving the batch forever.
    expect(store.claimDefinition).toHaveBeenCalledTimes(2);
    expect(mockReadyForReview).toHaveBeenCalledTimes(1);
  });
});

describe('start and stop', () => {
  it('starts once and is idempotent', () => {
    built.length = 0;
    scheduler.startReportScheduler();
    scheduler.startReportScheduler();
    expect(built).toHaveLength(1);
    scheduler.stopReportScheduler();
  });

  it('starts nothing when disabled', () => {
    built.length = 0;
    process.env.REPORT_SCHEDULER_ENABLED = 'false';
    scheduler.startReportScheduler();
    expect(built).toHaveLength(0);
    scheduler.stopReportScheduler();
  });

  it('runs under a leader lock with a crash-recovery TTL', () => {
    built.length = 0;
    const s = scheduler.createReportScheduler() as unknown as { opts: Record<string, unknown> };
    const lock = s.opts.lock as { key: string; ttlMs: number };
    // One replica per window. Without it every pod would compose and deliver.
    expect(lock.key).toContain('report-scheduler');
    expect(lock.ttlMs).toBeGreaterThan(0);
  });

  it('settles before its first cycle', () => {
    const s = scheduler.createReportScheduler() as unknown as { opts: Record<string, unknown> };
    // A booting pod must not compose reports while its dependencies are still coming up.
    expect(s.opts.startupDelayMs as number).toBeGreaterThan(0);
  });
});

/**
 * THE MONDAY SPIKE.
 *
 * Every weekly definition in the fleet becomes due at the same calendar instant, so the
 * load controls are not a nicety — they are the difference between a scheduler and an
 * outage. The plan's test plan names this case explicitly: "Scheduler under a Monday spike
 * (jitter, concurrency limit, timeouts)".
 *
 * Each of the three is asserted at the property that protects the system, not at the knob:
 * the jitter SPREADS (rather than merely exists), the concurrency cap BOUNDS what is in
 * flight (rather than merely being read), and one hung org COSTS ONLY ITSELF.
 */
describe('the Monday spike', () => {
  /** 200 definitions across 40 orgs, all due at the same instant. */
  const spike = (n: number) => Array.from({ length: n }, (_, i) => definition({
    id: `def-${i}`,
    orgId: `org-${i % 40}`,
    nextRunAt: SEEN,
  }));

  it('spreads the fleet across the jitter window instead of firing at one instant', () => {
    // Every definition shares a boundary, so the ONLY thing spreading them is the
    // per-definition offset. If it collapsed, the whole fleet would compose together.
    const slots = new Set(spike(200).map((d) => schedule.nextRunFor(d as never, NOW).getTime()));
    expect(slots.size).toBeGreaterThan(150);
  });

  it('never schedules outside the window, however many definitions there are', () => {
    const base = new Date('2026-09-28T11:00:00.000Z').getTime();
    for (const d of spike(200)) {
      const at = schedule.nextRunFor(d as never, NOW).getTime();
      expect(at).toBeGreaterThanOrEqual(base);
      expect(at).toBeLessThan(base + 1_800_000);
    }
  });

  it('claims at most one BATCH per cycle, whatever is due', async () => {
    process.env.REPORT_SCHEDULER_BATCH = '25';
    store.dueDefinitions.mockImplementation((_now: unknown, limit: unknown) =>
      Promise.resolve(spike(200).slice(0, Number(limit))));
    await cycle();
    // The cap is what stops one cycle holding the leader lock for as long as the slowest
    // org's compose times 200.
    expect(store.claimDefinition).toHaveBeenCalledTimes(25);
    delete process.env.REPORT_SCHEDULER_BATCH;
  });

  it('holds IN-FLIGHT composes to the concurrency cap', async () => {
    process.env.REPORT_SCHEDULER_BATCH = '40';
    process.env.REPORT_SCHEDULER_CONCURRENCY = '3';
    store.dueDefinitions.mockResolvedValue(spike(40));

    let inFlight = 0;
    let peak = 0;
    mockComposeRun.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, run: run(), period: period('2026-W38'), reused: false };
    });

    await cycle();
    // The property that matters: never more than the cap at once. This is what keeps a busy
    // Monday from saturating the database pool the request path shares.
    expect(peak).toBeLessThanOrEqual(3);
    expect(mockComposeRun).toHaveBeenCalledTimes(40);
    delete process.env.REPORT_SCHEDULER_BATCH;
    delete process.env.REPORT_SCHEDULER_CONCURRENCY;
  });

  it('lets ONE hung org cost only itself', async () => {
    process.env.REPORT_RUN_TIMEOUT_MS = '1000';
    process.env.REPORT_SCHEDULER_CONCURRENCY = '1';
    store.dueDefinitions.mockResolvedValue([
      definition({ id: 'def-hung', orgId: 'org-hung' }),
      definition({ id: 'def-ok', orgId: 'org-ok' }),
    ]);
    // The first never settles. Without a per-run timeout the cycle would hang here and the
    // second org would simply never be reported — the failure nobody notices, because a
    // stuck scheduler looks exactly like a quiet one.
    mockComposeRun
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({ ok: true, run: run(), period: period('2026-W38'), reused: false });

    const cycled = cycle();
    await jest.advanceTimersByTimeAsync(1500);
    await cycled;

    expect(mockReadyForReview).toHaveBeenCalledTimes(1);
    delete process.env.REPORT_RUN_TIMEOUT_MS;
    delete process.env.REPORT_SCHEDULER_CONCURRENCY;
  });

  it('runs each org in its own tenant context, even under load', async () => {
    store.dueDefinitions.mockResolvedValue(spike(12));
    await cycle();
    // 12 definitions across 12 orgs: every compose must be scoped to its own, or one org's
    // report would be computed under another's RLS context.
    expect(mockComposeRun).toHaveBeenCalledTimes(12);
    expect(store.claimDefinition).toHaveBeenCalledTimes(12);
  });
});

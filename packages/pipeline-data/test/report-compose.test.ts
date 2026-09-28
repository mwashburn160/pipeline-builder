// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The section registry, the templates, and the composer.
 *
 * What is pinned here is the product rules, not the plumbing:
 *
 *  - A gated section renders LOCKED and the report still delivers. A run that
 *    dies because one DORA section was included is a support ticket; a locked
 *    panel is an upsell.
 *  - Per-person sections are refused at REGISTRATION. Ranking individuals in a
 *    report a manager reads destroys trust in every other number in it, and a
 *    guideline in a document does not stop someone adding one later.
 *  - Missing deploy data is STATED, never rendered as zero. "0 deploys" and "we
 *    cannot see your deploys" look identical on a chart and mean opposite things.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { composeSnapshot, LOW_SAMPLE_THRESHOLD } from '../src/api/reporting/stakeholder/compose.js';
import { resolvePeriod } from '../src/api/reporting/stakeholder/period.js';
import { allSections, getSection, registerSection, sectionIds } from '../src/api/reporting/stakeholder/sections.js';
import type { SectionDataSource } from '../src/api/reporting/stakeholder/sections.js';
import { getTemplate, REPORT_TEMPLATE_SPECS } from '../src/api/reporting/stakeholder/templates.js';

const PERIOD = resolvePeriod('weekly', 'UTC', 'monday', new Date('2026-09-23T12:00:00Z'));

/** A data source whose every method resolves to `{}` unless overridden. */
function stubSource(over: Partial<Record<keyof SectionDataSource, unknown>> = {}): SectionDataSource {
  const base = {} as Record<string, unknown>;
  const names: Array<keyof SectionDataSource> = [
    'getExecutionCount', 'getSuccessRate', 'getAverageDuration', 'getStageFailures',
    'getStageBottlenecks', 'getActionFailures', 'getErrors', 'getPluginSummary',
    'getPluginDistribution', 'getPluginVersions', 'getBuildSuccessRate', 'getBuildDuration',
    'getBuildFailures', 'getDoraMetrics', 'getDoraTrend', 'getBuildHealth', 'getReportEnvironments',
    // The analytics reads (the rollup tables rather than raw events).
    'getPipelineBreakdown', 'getFailureAnalysis', 'getStagePerformance',
    'getResourceConsumption', 'getPromotionView', 'getOutdatedPlugins',
    'getPluginVulnerabilities', 'getAdoption',
    // The two OPTIONAL reads. Stubbed here so the end-to-end template test
    // exercises the wired path; the composer's own tests cover the unwired one,
    // where the section reports "unavailable" instead of failing the run.
    'getCompliancePosture', 'getNeedsAttention',
  ];
  for (const n of names) {
    const value = over[n];
    // `getPipelineBreakdown` is read as a LIST by the stage-performance section
    // (it drills into the worst pipeline), so its default has to be array-shaped —
    // an `{}` default would make that section throw rather than render empty.
    const fallback: unknown = n === 'getPipelineBreakdown' ? [] : {};
    base[n] = jest.fn(async () => (value !== undefined ? value : fallback));
  }
  return base as unknown as SectionDataSource;
}

const ALL_FEATURES = ['advanced_reporting', 'stakeholder_reports'];

function opts(over: Record<string, unknown> = {}) {
  return {
    source: stubSource(),
    period: PERIOD,
    timezone: 'UTC',
    weekStart: 'monday' as const,
    orgId: 'org-1',
    features: ALL_FEATURES,
    now: new Date('2026-09-23T12:00:00Z'),
    ...over,
  };
}

describe('section registry', () => {
  it('registers a section per ReportingService read method that a report can use', () => {
    // Every id is addressable, which is what lets a definition name one.
    expect(sectionIds().length).toBeGreaterThanOrEqual(15);
    expect(getSection('success_rate')).toBeDefined();
    expect(getSection('dora')).toBeDefined();
  });

  it('gates DORA sections on advanced_reporting, and leaves the rest free', () => {
    expect(getSection('dora')!.requiresFeature).toBe('advanced_reporting');
    expect(getSection('dora_trend')!.requiresFeature).toBe('advanced_reporting');
    // On-demand dashboard metrics stay free — the add-on sells scheduling and
    // publishing, not looking at your own success rate.
    expect(getSection('success_rate')!.requiresFeature).toBeUndefined();
    expect(getSection('execution_count')!.requiresFeature).toBeUndefined();
  });

  it('marks list sections as NOT comparable, so no nonsense trend arrow appears', () => {
    // "Top failing stages, down 3%" is meaningless.
    expect(getSection('stage_failures')!.comparable).toBe(false);
    expect(getSection('errors')!.comparable).toBe(false);
    expect(getSection('success_rate')!.comparable).toBe(true);
  });

  it('gives every section a manager-facing title, not a metric name', () => {
    for (const s of allSections()) {
      expect([s.id, s.title.length > 0]).toEqual([s.id, true]);
      // No snake_case metric identifiers leaking into the report.
      expect([s.id, /_/.test(s.title)]).toEqual([s.id, false]);
    }
  });

  it('REFUSES a per-person section at registration', () => {
    // The guardrail has to be executable. A comment saying "team-level only" does
    // not stop the next person adding a leaderboard.
    for (const id of ['top_committers', 'per_member_success', 'developer_ranking', 'failures_by_user']) {
      expect(() => registerSection({
        id, title: 'Nope', comparable: true, run: async () => ({}),
      })).toThrow(/per-person/);
    }
  });

  it('refuses a duplicate id', () => {
    expect(() => registerSection({
      id: 'success_rate', title: 'Dup', comparable: true, run: async () => ({}),
    })).toThrow(/Duplicate/);
  });
});

describe('templates', () => {
  it('every template resolves to registered sections', () => {
    // templates.ts asserts this at module load; this proves the assertion works
    // rather than trusting that it ran.
    for (const t of REPORT_TEMPLATE_SPECS) {
      for (const id of t.sections) {
        expect([t.id, id, getSection(id) !== undefined]).toEqual([t.id, id, true]);
      }
    }
  });

  it('pairs each template with the cadence it is designed for', () => {
    expect(getTemplate('weekly_delivery')!.cadence).toBe('weekly');
    expect(getTemplate('monthly_health')!.cadence).toBe('monthly');
    expect(getTemplate('quarterly_review')!.cadence).toBe('quarterly');
  });

  it('keeps DORA out of the WEEKLY template', () => {
    // Weekly DORA on a normal team is too small a sample to mean anything, and for
    // an org without the add-on the locked panel would dominate the page.
    expect(getTemplate('weekly_delivery')!.sections).not.toContain('dora');
    expect(getTemplate('monthly_health')!.sections).toContain('dora');
  });

  /**
   * A template opens with either the DECISION (`needs_attention`) or a comparable
   * headline — never a table or a list.
   *
   * This used to require a comparable headline outright. Leading with the decision
   * is better where there is one: a weekly report's job is to answer "what should I
   * look at", and a short list of flagged pipelines answers it where "1,204 runs"
   * makes the reader go looking. What the rule still forbids is opening with a
   * table — a per-pipeline breakdown or a plugin inventory first means the lead does
   * the finding, which is the work the report was supposed to do.
   */
  it('leads each template with the decision or an "are we shipping" headline, never a table', () => {
    for (const t of REPORT_TEMPLATE_SPECS) {
      const firstId = t.sections[0];
      const first = getSection(firstId)!;
      const opensWell = firstId === 'needs_attention' || first.comparable;
      expect([t.id, firstId, opensWell]).toEqual([t.id, firstId, true]);
    }
  });
});

describe('composeSnapshot', () => {
  it('runs a comparable section for BOTH periods and reports the change', async () => {
    const source = stubSource({
      getSuccessRate: [{ period: 'p', succeeded: 9, failed: 1, total: 10, success_pct: 90 }],
    });
    const snap = await composeSnapshot(['success_rate'], opts({ source }));
    const section = snap.sections[0];
    expect(section.state).toBe('ok');
    expect(section.headline).toEqual({ label: 'Success rate', value: 90, unit: '%' });
    // Same stub both periods ⇒ no change, direction flat (not 'unknown').
    expect(section.change).toEqual({ absolute: 0, percent: 0, direction: 'flat' });
    expect(section.previous).toBeDefined();
  });

  it('does not run a second query for a non-comparable section', async () => {
    const source = stubSource({ getStageFailures: [{ stage: 'test', failures: 3 }] });
    await composeSnapshot(['stage_failures'], opts({ source }));
    expect((source.getStageFailures as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('LOCKS a gated section and still delivers the rest of the report', async () => {
    // A feature that is neither the required one NOR a substitute for it. Using
    // `stakeholder_reports` here would pass for the wrong reason — it now satisfies
    // `advanced_reporting` inside a report, which the next test is about.
    const snap = await composeSnapshot(['dora', 'success_rate'], opts({ features: ['sso'] }));
    const dora = snap.sections.find((s) => s.id === 'dora')!;
    expect(dora.state).toBe('locked');
    expect(dora.requiresFeature).toBe('advanced_reporting');
    // The ungated section still ran — one locked panel must not cost the report.
    expect(snap.sections.find((s) => s.id === 'success_rate')!.state).toBe('ok');
    expect(snap.notes.some((n) => n.code === 'section_locked')).toBe(true);
  });

  it('locks a gated section for an org holding NO features at all', async () => {
    const snap = await composeSnapshot(['dora'], opts({ features: [] }));
    expect(snap.sections[0]?.state).toBe('locked');
  });

  /**
   * The add-on buys the DORA SECTIONS of a report; it does not buy the live DORA
   * dashboard, which stays gated on its own routes. Without this, a Pro customer who
   * bought Stakeholder Reports would open their first weekly report and find its
   * headline panels locked behind a second purchase the add-on's own description does
   * not mention.
   */
  it('lets stakeholder_reports satisfy a section that requires advanced_reporting', async () => {
    const snap = await composeSnapshot(['dora'], opts({ features: ['stakeholder_reports'] }));
    expect(snap.sections[0]?.state).toBe('ok');
    expect(snap.notes.some((n) => n.code === 'section_locked')).toBe(false);
  });

  it('still honours the feature the section actually names', async () => {
    const snap = await composeSnapshot(['dora'], opts({ features: ['advanced_reporting'] }));
    expect(snap.sections[0]?.state).toBe('ok');
  });

  it('does not let the substitution run in the other direction', async () => {
    // `advanced_reporting` must NOT unlock a section that needs `stakeholder_reports`:
    // the carve-out is one-way, and a symmetric implementation would hand the reports
    // add-on to every DORA customer for free.
    const snap = await composeSnapshot(['success_rate'], opts({ features: ['advanced_reporting'] }));
    // `success_rate` is ungated, so assert the rule at its source instead.
    expect(snap.sections[0]?.state).toBe('ok');
    const { REPORT_FEATURE_SUBSTITUTES } = await import('../src/api/reporting/stakeholder/compose.js');
    expect(REPORT_FEATURE_SUBSTITUTES.stakeholder_reports).toBeUndefined();
    expect(REPORT_FEATURE_SUBSTITUTES.advanced_reporting).toEqual(['stakeholder_reports']);
  });

  it('marks a throwing section failed and keeps going', async () => {
    const source = stubSource();
    (source.getSuccessRate as jest.Mock).mockImplementation(() => { throw new Error('db down'); });
    const snap = await composeSnapshot(['success_rate', 'stage_failures'], opts({ source }));
    expect(snap.sections[0].state).toBe('failed');
    expect(snap.sections[1].state).toBe('ok');
    expect(snap.notes.some((n) => n.code === 'section_failed')).toBe(true);
  });

  it('never leaks an error message into a note a manager reads', async () => {
    const source = stubSource();
    (source.getSuccessRate as jest.Mock).mockImplementation(() => { throw new Error('ECONNREFUSED 10.0.1.5:5432'); });
    const snap = await composeSnapshot(['success_rate'], opts({ source }));
    const note = snap.notes.find((n) => n.code === 'section_failed')!;
    expect(note.message).not.toContain('ECONNREFUSED');
    expect(note.message).not.toContain('10.0.1.5');
  });

  it('keeps this period when only the COMPARISON query fails', async () => {
    const source = stubSource({ getSuccessRate: [{ success_pct: 88, total: 50 }] });
    let call = 0;
    (source.getSuccessRate as jest.Mock).mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('previous period unavailable');
      return [{ success_pct: 88, total: 50 }];
    });
    const snap = await composeSnapshot(['success_rate'], opts({ source }));
    expect(snap.sections[0].state).toBe('ok');
    expect(snap.sections[0].headline!.value).toBe(88);
    expect(snap.sections[0].change!.direction).toBe('unknown');
  });

  it('reports a null percent rather than infinity when the baseline was zero', async () => {
    const source = stubSource();
    let call = 0;
    (source.getExecutionCount as jest.Mock).mockImplementation(async () => {
      call += 1;
      return call === 1 ? [{ total: 5 }] : [{ total: 0 }];
    });
    const snap = await composeSnapshot(['execution_count'], opts({ source }));
    // 0 → 5 is "5 more", never "+∞%".
    expect(snap.sections[0].change).toMatchObject({ absolute: 5, percent: null, direction: 'up' });
  });

  it('treats a drop to ZERO as a real headline, not missing data', async () => {
    // The most important thing a weekly report can say is "we shipped nothing this
    // week, down from 12". Treating 0 as absent made exactly that case vanish.
    const source = stubSource();
    let call = 0;
    (source.getExecutionCount as jest.Mock).mockImplementation(async () => {
      call += 1;
      return call === 1 ? [{ total: 0 }] : [{ total: 12 }];
    });
    const snap = await composeSnapshot(['execution_count'], opts({ source }));
    expect(snap.sections[0].headline).toEqual({ label: 'Total', value: 0 });
    expect(snap.sections[0].change).toMatchObject({ absolute: -12, direction: 'down' });
  });

  it('still reports no headline when the rows carry no count at all', async () => {
    // Genuinely absent is different from zero: no count field means there is
    // nothing to headline, and no arrow should be invented.
    const source = stubSource({ getExecutionCount: [{ pipelineName: 'web' }] });
    const snap = await composeSnapshot(['execution_count'], opts({ source }));
    expect(snap.sections[0].headline).toBeUndefined();
  });

  it('states that deploy data is missing instead of showing zero deploys', async () => {
    const source = stubSource({
      getDoraMetrics: {
        environments: [{ deploymentFrequency: { deployments: 0 }, changeFailureRate: { attempts: 0 }, leadTime: { medianSeconds: null } }],
        coverage: { registered: 5, deploying: 3, withoutDeploys: 2 },
      },
    });
    const snap = await composeSnapshot(['dora'], opts({ source }));
    const note = snap.notes.find((n) => n.code === 'missing_deploy_tag')!;
    expect(note.message).toContain('2 pipelines');
    expect(note.message).toContain('not "zero deploys"');
  });

  it('states that lead time is unmeasurable rather than implying it is instant', async () => {
    const source = stubSource({
      getDoraMetrics: {
        environments: [{ deploymentFrequency: { deployments: 4 }, changeFailureRate: { attempts: 4 }, leadTime: { medianSeconds: null } }],
        coverage: { registered: 1, deploying: 1, withoutDeploys: 0 },
      },
    });
    const snap = await composeSnapshot(['dora'], opts({ source }));
    expect(snap.notes.some((n) => n.code === 'missing_commit_data')).toBe(true);
  });

  it('flags a low sample, because percentages swing wildly at that volume', async () => {
    const source = stubSource({ getExecutionCount: [{ total: LOW_SAMPLE_THRESHOLD - 2 }] });
    const snap = await composeSnapshot(['execution_count'], opts({ source }));
    const note = snap.notes.find((n) => n.code === 'low_sample')!;
    expect(note.message).toContain('Read the counts, not the rate');
  });

  it('does not flag a healthy sample', async () => {
    const source = stubSource({ getExecutionCount: [{ total: 250 }] });
    const snap = await composeSnapshot(['execution_count'], opts({ source }));
    expect(snap.notes.some((n) => n.code === 'low_sample')).toBe(false);
  });

  it('records an unknown section id rather than silently dropping the panel', async () => {
    const snap = await composeSnapshot(['no_such_section'], opts());
    expect(snap.sections[0].state).toBe('failed');
    expect(snap.notes[0].message).toContain('Unknown report section');
  });

  it('is self-describing: period, timezone and methodology travel with the snapshot', async () => {
    // The snapshot outlives the raw events, so it has to carry enough to be read
    // years later without the definition that produced it.
    const snap = await composeSnapshot(['success_rate'], opts());
    expect(snap.period.label).toBe(PERIOD.label);
    expect(snap.period.start).toBe(PERIOD.start.toISOString());
    expect(snap.previousPeriod.start).toBe(PERIOD.prevStart.toISOString());
    expect(snap.timezone).toBe('UTC');
    expect(snap.methodology).toContain('same queries the dashboard runs');
    expect(snap.generatedAt).toBe('2026-09-23T12:00:00.000Z');
  });

  it('passes the report timezone down to the bucketed sections', async () => {
    const source = stubSource();
    await composeSnapshot(['success_rate'], opts({ source, timezone: 'America/Chicago', weekStart: 'sunday' }));
    expect(source.getSuccessRate as jest.Mock).toHaveBeenCalledWith(
      'org-1', 'week', expect.any(String), expect.any(String), undefined,
      { tz: 'America/Chicago', weekStart: 'sunday' },
    );
  });

  it('passes the rollup org ids through when the scope is a team rollup', async () => {
    const source = stubSource();
    await composeSnapshot(['success_rate'], opts({ source, orgIds: ['org-1', 'team-a'] }));
    expect(source.getSuccessRate as jest.Mock).toHaveBeenCalledWith(
      'org-1', 'week', expect.any(String), expect.any(String), ['org-1', 'team-a'], expect.anything(),
    );
  });

  it('composes a whole template end to end', async () => {
    const template = getTemplate('weekly_delivery')!;
    const snap = await composeSnapshot(template.sections, opts());
    expect(snap.sections).toHaveLength(template.sections.length);
    expect(snap.sections.every((s) => s.state === 'ok')).toBe(true);
  });
});

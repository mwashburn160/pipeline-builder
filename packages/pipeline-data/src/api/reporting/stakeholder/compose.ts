// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The composer: turn a definition's section list into the snapshot a manager reads.
 *
 * Three things it does that the raw queries do not:
 *
 *  - PERIOD-OVER-PERIOD. Every comparable section is run twice, for this period
 *    and the one before, so the snapshot carries "91% (down 3 points)". The trend
 *    is what a manager acts on; the absolute number alone rarely is.
 *  - LOCKED SECTIONS. A section whose feature the org lacks renders as locked
 *    instead of failing the run. A report that dies because one gated section was
 *    included is a support ticket; a locked panel is an upsell.
 *  - DATA-QUALITY NOTES. Missing deploy tags and tiny samples are stated, not
 *    silently rendered as zero. "0 deploys" and "we cannot see your deploys" look
 *    identical on a chart and mean opposite things — a manager reading the first
 *    when it is really the second draws exactly the wrong conclusion.
 */

import type { ResolvedPeriod } from './period.js';
import { getSection, type SectionContext, type SectionDataSource, type SectionSpec } from './sections.js';

/** Below this many observations a rate is noise, and says so. */
export const LOW_SAMPLE_THRESHOLD = 5;

/** Which way a metric moved. `flat` when the change rounds to nothing. */
export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';

/** A data-quality caveat attached to the whole snapshot. */
export interface DataQualityNote {
  code: 'missing_deploy_tag' | 'missing_commit_data' | 'low_sample' | 'section_failed' | 'section_locked';
  /** Manager-readable. Not a metric name and not a stack trace. */
  message: string;
  /** The section it concerns, when it is section-specific. */
  sectionId?: string;
}

/** One composed section. */
export interface ComposedSection {
  id: string;
  title: string;
  /** `locked` when the org lacks the feature; `failed` when the query threw. */
  state: 'ok' | 'locked' | 'failed';
  /** The feature needed, when locked — drives the upsell copy. */
  requiresFeature?: string;
  /** This period's raw result, exactly as the dashboard would show it. */
  current?: unknown;
  /** The previous period's result, for comparable sections. */
  previous?: unknown;
  /** The single number a manager reads first, when the section has one. */
  headline?: { label: string; value: number; unit?: string };
  /** Change versus the previous period, for comparable sections. */
  change?: { absolute: number; percent: number | null; direction: TrendDirection };
}

/** The frozen output of one run. */
export interface ReportSnapshot {
  /** Period bounds + label, copied in so the snapshot is self-describing. */
  period: { start: string; end: string; label: string };
  previousPeriod: { start: string; end: string };
  timezone: string;
  weekStart: 'monday' | 'sunday';
  sections: ComposedSection[];
  notes: DataQualityNote[];
  /**
   * How every number here was produced, shown in the report footer. Managers
   * compare reports to the dashboard; saying plainly that both run the same
   * queries over the same window is what makes a difference investigable rather
   * than a reason to distrust both.
   */
  methodology: string;
  generatedAt: string;
}

/** What the composer needs to know about the org's entitlements. */
export interface ComposeOptions {
  source: SectionDataSource;
  period: ResolvedPeriod;
  timezone: string;
  weekStart: 'monday' | 'sunday';
  orgId: string;
  orgIds?: string[];
  /** Features the org holds. A section needing one that is absent renders locked. */
  features: readonly string[];
  now?: Date;
}

/** Pull a comparable number out of a section result, or null when there isn't one. */
function headlineOf(sectionId: string, value: unknown): { label: string; value: number; unit?: string } | null {
  if (value === null || value === undefined) return null;

  // Time series (success rate, build success): the LAST bucket is "now".
  if (Array.isArray(value) && value.length > 0) {
    const last = value[value.length - 1] as Record<string, unknown>;
    if (typeof last?.success_pct === 'number') return { label: 'Success rate', value: last.success_pct, unit: '%' };
    // Execution counts: total runs across pipelines.
    //
    // A total of ZERO is a real headline, not missing data: "0 deploys, down from
    // 5" is the single most important thing a weekly report can tell a manager,
    // and treating 0 as "no value" made exactly that case disappear — the change
    // came back `unknown` and no arrow was shown. So the test is whether any row
    // CARRIED a count, not whether the sum is positive.
    let counted = false;
    const total = (value as Array<Record<string, unknown>>).reduce((sum, row) => {
      const n = row.total ?? row.count ?? row.executions;
      if (typeof n !== 'number') return sum;
      counted = true;
      return sum + n;
    }, 0);
    if (counted) return { label: 'Total', value: total };
    return null;
  }

  const obj = value as Record<string, unknown>;
  // DORA: deployment frequency is the headline a manager recognises.
  const envs = obj.environments;
  if (Array.isArray(envs) && envs.length > 0) {
    const first = envs[0] as Record<string, unknown>;
    const df = (first.deploymentFrequency as Record<string, unknown> | undefined)?.deployments;
    if (typeof df === 'number') return { label: 'Deploys', value: df };
  }
  // Plugin summary and friends: a plain total.
  // Zero is a value here too — `plugin_versions` reporting 0 outdated plugins is
  // good news a manager should see, not an absent section.
  for (const key of ['total', 'count', 'deployments']) {
    if (typeof obj[key] === 'number') return { label: sectionId === 'plugin_versions' ? 'Outdated' : 'Total', value: obj[key] as number };
  }
  return null;
}

/** Change between two headline numbers. */
function changeOf(
  current: { value: number } | null,
  previous: { value: number } | null,
): ComposedSection['change'] {
  if (!current || !previous) return { absolute: 0, percent: null, direction: 'unknown' };
  const absolute = Number((current.value - previous.value).toFixed(2));
  // A percent change off a zero baseline is undefined, not infinite: going from 0
  // to 5 deploys is "5 more", never "+∞%".
  const percent = previous.value === 0 ? null : Number(((absolute / previous.value) * 100).toFixed(1));
  const direction: TrendDirection = absolute === 0 ? 'flat' : absolute > 0 ? 'up' : 'down';
  return { absolute, percent, direction };
}

/** Count the observations behind a section, for the low-sample note. */
function sampleSize(value: unknown): number | null {
  if (Array.isArray(value)) {
    return (value as Array<Record<string, unknown>>).reduce((sum, row) => {
      const n = row.total ?? row.count ?? row.executions ?? row.deployments;
      return sum + (typeof n === 'number' ? n : 0);
    }, 0);
  }
  const obj = value as Record<string, unknown> | null;
  const envs = obj?.environments;
  if (Array.isArray(envs)) {
    return envs.reduce((sum: number, e) => {
      const attempts = ((e as Record<string, unknown>).changeFailureRate as Record<string, unknown> | undefined)?.attempts;
      return sum + (typeof attempts === 'number' ? attempts : 0);
    }, 0);
  }
  return null;
}

/** Deploy-coverage notes: the difference between "zero deploys" and "blind". */
function deployCoverageNotes(dora: unknown): DataQualityNote[] {
  const notes: DataQualityNote[] = [];
  const coverage = (dora as Record<string, unknown> | null)?.coverage as Record<string, unknown> | undefined;
  const without = coverage?.withoutDeploys;
  if (typeof without === 'number' && without > 0) {
    notes.push({
      code: 'missing_deploy_tag',
      sectionId: 'dora',
      message: `Deploy data unavailable for ${without} pipeline${without === 1 ? '' : 's'}: they have not re-synthed with deploy tags, so their deploys are not counted here. This is not "zero deploys".`,
    });
  }
  const envs = (dora as Record<string, unknown> | null)?.environments;
  if (Array.isArray(envs)) {
    const noLead = (envs as Array<Record<string, unknown>>).filter((e) => {
      const lt = e.leadTime as Record<string, unknown> | undefined;
      return lt && lt.medianSeconds === null;
    });
    if (noLead.length > 0) {
      notes.push({
        code: 'missing_commit_data',
        sectionId: 'dora',
        message: `Lead time unavailable for ${noLead.length} environment${noLead.length === 1 ? '' : 's'}: no successful deploy carried a resolvable commit timestamp, so commit-to-deploy time could not be measured.`,
      });
    }
  }
  return notes;
}

/**
 * Compose one period's snapshot.
 *
 * Never throws for a section-level problem: a section that fails is marked
 * `failed` with a note, and the rest of the report still reaches the lead. A run
 * that produces nine good sections and one failure is useful; a run that produces
 * an exception is not.
 */
export async function composeSnapshot(sectionIdList: readonly string[], opts: ComposeOptions): Promise<ReportSnapshot> {
  const { source, period, timezone, weekStart, orgId, orgIds, features } = opts;
  const notes: DataQualityNote[] = [];
  const sections: ComposedSection[] = [];

  const ctxFor = (from: Date, to: Date): SectionContext => ({
    orgId,
    ...(orgIds ? { orgIds } : {}),
    from: from.toISOString(),
    to: to.toISOString(),
    tz: timezone,
    weekStart,
    // The previous period travels WITH the context, for the analytics sections
    // whose trend is per category, per stage or per pipeline. Those cannot be
    // handled by running the section twice and comparing one headline — the
    // comparison is a join, and doing it in the composer afterwards would mean
    // re-implementing it for every shape.
    previousFrom: period.prevStart.toISOString(),
    previousTo: period.prevEnd.toISOString(),
  });
  const currentCtx = ctxFor(period.start, period.end);
  const previousCtx = ctxFor(period.prevStart, period.prevEnd);

  for (const id of sectionIdList) {
    const spec: SectionSpec | undefined = getSection(id);
    if (!spec) {
      // An unknown id is a definition referencing a section that no longer exists.
      // Recorded rather than dropped, so the lead can see why a panel vanished.
      sections.push({ id, title: id, state: 'failed' });
      notes.push({ code: 'section_failed', sectionId: id, message: `Unknown report section "${id}" — it may have been removed.` });
      continue;
    }

    if (spec.requiresFeature && !features.includes(spec.requiresFeature)) {
      sections.push({
        id, title: spec.title, state: 'locked', requiresFeature: spec.requiresFeature,
      });
      notes.push({
        code: 'section_locked',
        sectionId: id,
        message: `"${spec.title}" needs the ${spec.requiresFeature} add-on. The rest of this report is unaffected.`,
      });
      continue;
    }

    try {
      const current = await spec.run(source, currentCtx);
      const composed: ComposedSection = { id, title: spec.title, state: 'ok', current };

      const head = headlineOf(id, current);
      if (head) composed.headline = head;

      if (spec.comparable) {
        // The comparison is best-effort: a failed previous period must not cost the
        // lead this period's numbers.
        try {
          const previous = await spec.run(source, previousCtx);
          composed.previous = previous;
          composed.change = changeOf(head, headlineOf(id, previous));
        } catch {
          composed.change = { absolute: 0, percent: null, direction: 'unknown' };
        }
      }

      const sample = sampleSize(current);
      if (sample !== null && sample > 0 && sample < LOW_SAMPLE_THRESHOLD) {
        notes.push({
          code: 'low_sample',
          sectionId: id,
          message: `"${spec.title}" is based on ${sample} observation${sample === 1 ? '' : 's'} — percentages swing wildly at this volume. Read the counts, not the rate.`,
        });
      }

      if (id === 'dora') notes.push(...deployCoverageNotes(current));
      sections.push(composed);
    } catch (err) {
      sections.push({ id, title: spec.title, state: 'failed' });
      notes.push({
        code: 'section_failed',
        sectionId: id,
        message: `"${spec.title}" could not be computed for this period. The rest of the report is unaffected.`,
      });
      void err; // the reason is logged by the caller, never shown to a manager
    }
  }

  return {
    period: { start: period.start.toISOString(), end: period.end.toISOString(), label: period.label },
    previousPeriod: { start: period.prevStart.toISOString(), end: period.prevEnd.toISOString() },
    timezone,
    weekStart,
    sections,
    notes,
    methodology:
      `Computed from pipeline events between ${period.start.toISOString()} and ${period.end.toISOString()}, `
      + `bucketed in ${timezone} with weeks starting ${weekStart}. Comparison period: `
      + `${period.prevStart.toISOString()} to ${period.prevEnd.toISOString()}. `
      + 'These are the same queries the dashboard runs over the same window, so the two agree.',
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

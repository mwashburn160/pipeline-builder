// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Insights tab: the stakeholder report's ANALYTICS sections, on demand.
 *
 * Needs-attention, failure analysis, promotion, resource consumption, outdated
 * plugins and adoption used to exist only inside a saved report. This module runs
 * them for an arbitrary dashboard window — and it runs them by calling the
 * REGISTERED SECTION's own `run`, not by re-wiring the service methods. That is the
 * whole point: a lead who opens the Insights tab and a stakeholder report over the
 * same window and timezone must read the same numbers, and the only way that stays
 * true as the sections evolve is for there to be one implementation, not two.
 *
 * Every one of these sections reads the pre-aggregated tables
 * (`execution_daily_rollups`, `dora_deployments`, `pipeline_plugin_resolution`),
 * never raw events, so a 365-day window is a few-hundred-row query.
 *
 * Deliberately NOT here: plugin vulnerabilities and compliance posture (the
 * Security tab), and the per-pipeline stage drill-down (it needs a pipeline pick).
 */

import { createLogger, instantOfCivil, isUsableTimeZone, type WeekStart } from '@pipeline-builder/api-core';
import { getReportSection, type SectionContext, type SectionDataSource } from './stakeholder/sections.js';

const logger = createLogger('reporting-insights');

/** The report sections the Insights tab shows, in display order. */
export const INSIGHT_SECTION_IDS = [
  'needs_attention',
  'failure_analysis',
  'promotion',
  'resource_consumption',
  'outdated_plugins',
  'adoption',
] as const;

export type InsightSectionId = (typeof INSIGHT_SECTION_IDS)[number];

/** True when `id` is one of {@link INSIGHT_SECTION_IDS}. */
export function isInsightSectionId(id: string): id is InsightSectionId {
  return (INSIGHT_SECTION_IDS as readonly string[]).includes(id);
}

/** The window and scope one Insights read covers. */
export interface InsightsWindow {
  orgId: string;
  /** `[self, ...descendants]` for an authorized rollup; undefined = this org only. */
  orgIds?: string[];
  /** ISO instants (see {@link insightBound} for turning a dashboard day into one). */
  from: string;
  to: string;
  tz: string;
  weekStart: WeekStart;
  /**
   * The comparison window for the per-category / per-pipeline trend columns.
   * Defaults to the equal-length window ending at `from` ({@link previousWindowOf});
   * a stakeholder report passes its previous calendar period instead.
   */
  previous?: { from: string; to: string };
}

/** One section's result. A failure is isolated to its own card. */
export interface InsightSection {
  id: InsightSectionId;
  title: string;
  state: 'ok' | 'failed';
  /** Exactly what the stakeholder report stores as the section's `current`. */
  data?: unknown;
}

export interface InsightsResult {
  window: { from: string; to: string; tz: string; weekStart: WeekStart; previous: { from: string; to: string } };
  sections: InsightSection[];
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Turn a dashboard bound into an ISO instant in `tz`.
 *
 * The date pickers send `YYYY-MM-DD`. Read as UTC, a Chicago team's "Sept 1"
 * would start at 19:00 on Aug 31 locally — and no longer line up with the
 * stakeholder report, whose periods start at LOCAL midnight. So a date-only bound
 * becomes that day's local midnight; anything else is a full timestamp and is
 * normalized as-is. An unusable zone falls back to UTC (the route validates `tz`).
 */
export function insightBound(value: string, tz: string): string {
  const m = DATE_ONLY.exec(value);
  if (m) {
    const zone = isUsableTimeZone(tz) ? tz : 'UTC';
    return instantOfCivil({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, zone).toISOString();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

/** The equal-length window immediately before `[from, to)`. */
export function previousWindowOf(from: string, to: string): { from: string; to: string } {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) return { from, to: from };
  return { from: new Date(f - (t - f)).toISOString(), to: new Date(f).toISOString() };
}

/**
 * Run the Insights sections over one window.
 *
 * Sections run concurrently and fail independently: one card that could not be
 * computed must not blank the other five. The reason is logged, never returned —
 * the same rule the composer applies to a report a manager reads.
 */
export async function computeInsights(
  source: SectionDataSource,
  w: InsightsWindow,
  ids: readonly InsightSectionId[] = INSIGHT_SECTION_IDS,
): Promise<InsightsResult> {
  const previous = w.previous ?? previousWindowOf(w.from, w.to);
  const ctx: SectionContext = {
    orgId: w.orgId,
    ...(w.orgIds ? { orgIds: w.orgIds } : {}),
    from: w.from,
    to: w.to,
    tz: w.tz,
    weekStart: w.weekStart,
    previousFrom: previous.from,
    previousTo: previous.to,
  };

  const sections = await Promise.all(ids.map(async (id): Promise<InsightSection> => {
    const spec = getReportSection(id);
    if (!spec) return { id, title: id, state: 'failed' };
    try {
      return { id, title: spec.title, state: 'ok', data: await spec.run(source, ctx) };
    } catch (err) {
      logger.warn('Insights section failed', { section: id, orgId: w.orgId, err: String(err) });
      return { id, title: spec.title, state: 'failed' };
    }
  }));

  return { window: { from: w.from, to: w.to, tz: w.tz, weekStart: w.weekStart, previous }, sections };
}

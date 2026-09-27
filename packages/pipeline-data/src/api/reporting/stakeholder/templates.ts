// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The manager-facing templates.
 *
 * A template is a curated section list, not a free-form picker, because the
 * failure mode of this feature is a report nobody reads. Managers do not act on
 * "p95 stage duration"; they act on answers to four questions — are we shipping,
 * is it getting better or worse, what is blocking us, is anything risky. Each
 * template answers those in that order, so the first thing on the page is a
 * number with a direction rather than a table.
 *
 * Section ORDER is the reading order. It is deliberate and worth preserving.
 */

import { getSection } from './sections.js';
import type { ReportCadence, ReportTemplate } from '../../../database/schema/reporting-stakeholder.js';

/** A named, ordered section list with the cadence it is designed for. */
export interface TemplateSpec {
  id: ReportTemplate;
  /** What a lead picks in the UI. */
  label: string;
  /** One line explaining who it is for — shown next to the label. */
  audience: string;
  /** The cadence this template assumes. A weekly DORA report is mostly noise. */
  cadence: ReportCadence;
  sections: readonly string[];
}

export const REPORT_TEMPLATE_SPECS: readonly TemplateSpec[] = [
  {
    id: 'weekly_delivery',
    label: 'Weekly delivery summary',
    audience: 'For an engineering manager: what shipped this week and what is blocking it.',
    cadence: 'weekly',
    // Are we shipping → is it getting better → what is blocking us.
    // No DORA here: weekly DORA on a normal team is too small a sample to mean
    // anything, and the locked-section path would dominate the page for orgs
    // without the add-on.
    sections: [
      'execution_count',
      'success_rate',
      'stage_failures',
      'action_failures',
      'errors',
    ],
  },
  {
    id: 'monthly_health',
    label: 'Monthly engineering health',
    audience: 'For a director: delivery performance with DORA levels and trend.',
    cadence: 'monthly',
    // A month is the smallest window where DORA bands are meaningful.
    sections: [
      'dora',
      'dora_trend',
      'success_rate',
      'duration',
      'stage_bottlenecks',
      'build_success_rate',
      'plugin_versions',
    ],
  },
  {
    id: 'quarterly_review',
    label: 'Quarterly review',
    audience: 'For a leadership review: the quarter across teams, with quarter-over-quarter change.',
    cadence: 'quarterly',
    // Widest view: delivery, health, supply chain, and where we deploy.
    sections: [
      'dora',
      'dora_trend',
      'execution_count',
      'success_rate',
      'duration',
      'environments',
      'plugin_summary',
      'plugin_versions',
      'build_success_rate',
    ],
  },
];

/** Look a template up by id. */
export function getTemplate(id: string): TemplateSpec | undefined {
  return REPORT_TEMPLATE_SPECS.find((t) => t.id === id);
}

/**
 * Every section id a template names must exist in the registry. Called at module
 * load so a template referencing a removed section fails the BUILD rather than
 * producing a report full of "Unknown report section" panels in production.
 */
export function assertTemplatesResolve(): void {
  for (const template of REPORT_TEMPLATE_SPECS) {
    for (const id of template.sections) {
      if (!getSection(id)) {
        throw new Error(
          `Template "${template.id}" names unknown section "${id}". `
          + 'Register it in sections.ts or remove it from the template.',
        );
      }
    }
  }
}

assertTemplatesResolve();

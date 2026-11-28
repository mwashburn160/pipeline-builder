// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The pipeline detail page's shared types, tabs and execution-status helpers. */

import type { BadgeColor } from '@/components/ui/Badge';
import type { ExecutionFailure } from '@/lib/api/domains/reporting';
import type { PipelineRegistrationStatus } from '@/lib/api/domains/pipelines';
import type { Pipeline } from '@/types';

/**
 * The pipeline plus the registration that arrived with it. Carried on the entity
 * so the banner and the record it describes come from one response.
 */
export type PipelineWithRegistration = Pipeline & { registration?: PipelineRegistrationStatus };

export interface PipelineExecution {
  execution_id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  failing_stage: string | null;
  failing_action: string | null;
  /** Why a failed run failed (e.g. a plugin runtime check), when an event said. */
  failure?: ExecutionFailure | null;
}

/** Map a rolled-up execution status to a Badge color. */
export function statusColor(status: string): BadgeColor {
  if (status === 'succeeded') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'in-progress') return 'yellow';
  return 'gray'; // canceled / unknown
}


/** The plugin refs a failure names (`plugins` may be strings or `{ plugin, version }` objects). */
export function failurePlugins(f: ExecutionFailure): string[] {
  if (!Array.isArray(f.plugins)) return [];
  return f.plugins.map((p) => {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      const name = typeof o.plugin === 'string' ? o.plugin : typeof o.name === 'string' ? o.name : '';
      return name && typeof o.version === 'string' ? `${name}@${o.version}` : name;
    }
    return '';
  }).filter(Boolean);
}

export const DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs' },
  { id: 'security', label: 'Plugin security' },
] as const;
export type DetailTab = (typeof DETAIL_TABS)[number]['id'];
export const DETAIL_TAB_IDS: readonly DetailTab[] = DETAIL_TABS.map((t) => t.id);

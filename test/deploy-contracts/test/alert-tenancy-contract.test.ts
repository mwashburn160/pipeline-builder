// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A `tenancy: org` alert must still carry `org_id` when it fires.
 *
 * Alertmanager sends `tenancy = "org"` alerts to ops-center, which fans each one
 * out to the destinations of the org named by its `org_id` label — and that route
 * ends with `continue: false`, so the ops channels never see it. An org alert
 * whose expression aggregates `org_id` away (`sum by (quota_type) (...)`, or a
 * bare `sum(...)`) therefore reaches NOBODY. `PooledQuotaResolutionDenying` did
 * exactly that. Either keep `org_id` in every aggregation, or the alert is a
 * platform alert.
 */

import { describe, expect, it } from '@jest/globals';
import { parse } from 'yaml';
import { ALL_TARGETS, read } from '../src/index.js';

interface Rule { alert?: string; expr?: string; labels?: Record<string, string> }

const AGG = /\b(sum|max|min|avg|count|topk|bottomk|quantile|stddev|stdvar|group)\s*(by|without)?\s*(\(([^)]*)\))?\s*\(/g;

/** Aggregations in an expression that drop `org_id` (a `by` list without it, a `without` naming it, or none at all). */
function dropsOrgId(expr: string): string[] {
  // `label_replace(<agg>, "org_id", "$1", "<label>", ...)` re-derives org_id after
  // the aggregation (LokiRateCapBreach maps Loki's tenant to it) — that routes fine.
  if (/label_replace\([\s\S]*?"org_id"/.test(expr)) return [];
  const out: string[] = [];
  for (const m of expr.matchAll(AGG)) {
    const [whole, , mode, , list] = m;
    const labels = (list ?? '').split(',').map((s) => s.trim());
    if (mode === 'by' ? !labels.includes('org_id') : mode === 'without' ? labels.includes('org_id') : true) out.push(whole.trim());
  }
  return out;
}

describe.each(ALL_TARGETS.map((t) => [t]))('%s alert-rules.yml', (target) => {
  const doc = parse(read(`${target}/config/prometheus/alert-rules.yml`)) as { groups: { rules: Rule[] }[] };
  const orgRules = doc.groups.flatMap((g) => g.rules).filter((r) => r.alert && r.labels?.tenancy === 'org');

  it('has tenancy: org alerts to check (guards a vacuous pass)', () => {
    expect(orgRules.length).toBeGreaterThan(0);
  });

  it('never aggregates org_id away in a tenancy: org alert', () => {
    const offenders = orgRules
      .map((r) => ({ alert: r.alert, drops: dropsOrgId(r.expr ?? '') }))
      .filter((o) => o.drops.length > 0);
    expect(offenders).toEqual([]);
  });

  it('the check bites: a bare sum is flagged, a by (org_id) is not', () => {
    expect(dropsOrgId('sum by (quota_type) (rate(x[5m])) > 0')).toHaveLength(1);
    expect(dropsOrgId('sum(rate(x[5m])) > 0')).toHaveLength(1);
    expect(dropsOrgId('sum by (org_id, quota_type) (rate(x[5m])) > 0')).toHaveLength(0);
    expect(dropsOrgId('label_replace(sum by (tenant) (rate(x[5m])) > 0, "org_id", "$1", "tenant", "(.+)")')).toHaveLength(0);
  });
});

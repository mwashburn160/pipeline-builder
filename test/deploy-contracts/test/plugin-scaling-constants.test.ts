// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Numbers that live in YAML but are DERIVED from the build catalog.
 *
 * The plugin autoscaler and the replica-budget alert both encode figures that
 * come from `BUILD_TIER_CONCURRENCY`:
 *
 *  - the scaling query's fallback divides a raw job count by one replica's
 *    capacity, i.e. the ladder's SUM;
 *  - the budget alert fires at a level that only means "near capacity" relative
 *    to that same sum.
 *
 * Nothing connects them. Change a tier row and the code moves while three
 * manifests and four rule files keep the old arithmetic — silently, because both
 * are strings inside PromQL. That is how a threshold of 13 came to throttle a
 * fresh install to 71 minutes from 45, and it would not have shown up in any
 * unit test.
 *
 * api-core's constants are read from SOURCE rather than imported: this project
 * depends on `yaml` and the test tooling only, and the sibling guards here read
 * manifests the same way.
 */

import { describe, it, expect } from '@jest/globals';
import { read } from '../src/index.js';

/** The ladder's per-tier concurrency, parsed out of the catalog. */
function ladderSum(): number {
  const src = read('packages/api-core/src/types/build-catalog.ts');
  const block = /export const BUILD_TIER_CONCURRENCY[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('BUILD_TIER_CONCURRENCY not found in build-catalog.ts');
  const rows = [...block[1]!.matchAll(/^\s{2}(\w+):\s*(\d+),/gm)].map((m) => Number(m[2]));
  // Guards a vacuous pass: six tiers, or the regex has stopped matching.
  expect(rows).toHaveLength(6);
  return rows.reduce((a, b) => a + b, 0);
}

const SCALED_TREES = ['deploy/aws/eks', 'deploy/aws/ec2', 'deploy/local/minikube'];
const RULE_TREES = ['deploy/aws/eks', 'deploy/aws/ec2', 'deploy/local/docker', 'deploy/local/minikube'];

describe('the plugin scaling query tracks the build ladder', () => {
  it('parses a ladder sum at all', () => {
    expect(ladderSum()).toBe(13);
  });

  it.each(SCALED_TREES)('%s divides its fallback by the ladder sum', (tree) => {
    const yaml = read(`${tree}/k8s/plugin.yaml`);
    const query = /query: (clamp_max\(.*)\n/.exec(yaml)?.[1];
    expect(query).toBeDefined();
    // The `or` branch is the guard for a missing concurrency gauge; it divides a
    // raw job count by what ONE replica can absorb, which is the ladder's sum.
    const divisor = /\}\)\s*\/\s*(\d+)/.exec(query!)?.[1];
    expect(Number(divisor)).toBe(ladderSum());
  });

  it.each(SCALED_TREES)('%s weights per tier and takes the MAX, not the sum', (tree) => {
    const query = /query: (clamp_max\(.*)\n/.exec(read(`${tree}/k8s/plugin.yaml`))![1]!;
    // `max` because one replica serves every tier queue at once: summing per-tier
    // replica need double-counts (36 builds across six tiers asked for 21.7
    // replicas to run work already fitting on 8).
    expect(query).toContain('max(');
    expect(query).toContain('on(tier) group_left() plugin_build_tier_concurrency');
    // Threshold is 1 precisely because the query is denominated in REPLICAS.
    expect(read(`${tree}/k8s/plugin.yaml`)).toMatch(/plugin_build_tier_concurrency[\s\S]{0,200}?threshold: "1"/);
  });

  it.each(SCALED_TREES)('%s excludes `delayed`, where a cap-blocked job waits', (tree) => {
    // A job denied a slot is `moveToDelayed`. Counting it would ask for capacity
    // to run work that cannot start — the autoscaler would chase its own backlog.
    const query = /query: (clamp_max\(.*)\n/.exec(read(`${tree}/k8s/plugin.yaml`))![1]!;
    expect(query).toContain('state=~"waiting|active"');
    expect(query).not.toContain('delayed');
  });
});

describe('the replica-budget alert tracks the same ladder', () => {
  it.each(RULE_TREES)('%s fires below the budget, with headroom', (tree) => {
    const rules = read(`${tree}/config/prometheus/alert-rules.yml`);
    const expr = /expr: max\(plugin_build_replica_inflight\) >= (\d+)/.exec(rules);
    expect(expr).toBeDefined();
    const threshold = Number(expr![1]);
    const budget = ladderSum();
    // It must warn BEFORE the budget is reached (otherwise it reports a ceiling
    // already hit) and not so early that normal load pages: org caps hold a
    // replica near 8 today, so the band between is where this belongs.
    expect(threshold).toBeLessThan(budget);
    expect(threshold).toBeGreaterThanOrEqual(Math.ceil(budget * 0.6));
  });
});

// ---------------------------------------------------------------------------
// The promtool suite, made visible to the gate
// ---------------------------------------------------------------------------

/**
 * `deploy/local/minikube/config/prometheus/alert-rules.test.yml` holds 160+
 * promtool cases, and it is run by `deploy/bin/validate-configs.sh` against a
 * pinned Prometheus image — which **nothing in the build gate invokes**, and
 * which needs Docker. So a case can name an alert that no longer exists, or a
 * renamed alert can quietly lose its only coverage, and CI says nothing.
 *
 * These checks need no Docker: they hold the suite and the rules to each other,
 * and report which alerts carry cases. They do not replace promtool (it is what
 * evaluates the expressions over a time series) — they stop the file rotting
 * between the rare runs.
 */
describe('the promtool alert suite stays attached to the rules', () => {
  const RULES = 'deploy/local/minikube/config/prometheus/alert-rules.yml';
  const SUITE = 'deploy/local/minikube/config/prometheus/alert-rules.test.yml';

  const definedAlerts = (): Set<string> =>
    new Set([...read(RULES).matchAll(/^ {6}- alert: (\w+)$/gm)].map((m) => m[1]!));
  const testedAlerts = (): string[] =>
    [...read(SUITE).matchAll(/^ {8}alertname: (\w+)$/gm)].map((m) => m[1]!);

  it('parses both files (guards a vacuous pass)', () => {
    expect(definedAlerts().size).toBeGreaterThan(150);
    expect(testedAlerts().length).toBeGreaterThan(100);
  });

  it('names no alert that does not exist', () => {
    // A renamed or deleted alert leaves its cases pointing at nothing. promtool
    // reports that as a failing expectation, but only when someone runs it.
    const defined = definedAlerts();
    const orphans = [...new Set(testedAlerts())].filter((a) => !defined.has(a));
    expect(orphans).toEqual([]);
  });

  it('covers the alerts whose thresholds encode a customer COMMITMENT', () => {
    // Not a coverage percentage — a named list. These four are different:
    // SUPPORT_RESPONSE_TARGETS is described in the catalog as a commitment shown
    // on the case, the pricing page and in the alert that fires when the desk
    // misses it; and the audit/budget pair were added with no coverage at all.
    const tested = new Set(testedAlerts());
    for (const alert of [
      'SupportFirstResponseTargetMissed',
      'SupportPremiumFirstResponseAtRisk',
      'AuditHashComputationFailed',
      'PluginReplicaBuildBudgetSaturated',
    ]) {
      expect({ alert, covered: tested.has(alert) }).toEqual({ alert, covered: true });
    }
  });
});

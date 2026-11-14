// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The compliance service's own closed vocabularies — those that never leave this
 * service (the digest modes) and the helpers over the shared ones. The scan
 * target/status/trigger, exemption status/decision and check-result vocabularies
 * cross to pipeline-data's filters and the browser, so they are api-core's
 * `wire-vocabulary.ts` (`COMPLIANCE_*`) and are imported from there, never
 * re-listed; so are the rule vocabularies (targets, severities, operators, scopes).
 */

import { RULE_TARGETS, type ComplianceScanTarget, type RuleTarget } from '@pipeline-builder/api-core';

/** The rule targets a scan target expands to. */
export function ruleTargetsOf(target: ComplianceScanTarget): readonly RuleTarget[] {
  return target === 'all' ? RULE_TARGETS : [target];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Notification digest modes, keyed to how long a digest window lasts (`0` =
 * no batching: deliver immediately). The digest scheduler reads the interval
 * from here rather than a `weekly ? WEEK : DAY` ternary that would have batched
 * a third mode daily.
 */
export const DIGEST_INTERVAL_MS = {
  immediate: 0,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
} as const satisfies Record<string, number>;
export type DigestMode = keyof typeof DIGEST_INTERVAL_MS;
export const DIGEST_MODES = Object.keys(DIGEST_INTERVAL_MS) as [DigestMode, ...DigestMode[]];

/** Whether a stored digest mode batches notifications — anything set other than `immediate`. */
export function isBatchedDigestMode(mode: string | null | undefined): boolean {
  return !!mode && mode !== 'immediate';
}

/**
 * How long one digest window of `mode` lasts. A stored value outside the
 * catalog batches daily, which is what the scheduler did before the catalog
 * existed (the column is free text; the write path validates).
 */
export function digestIntervalMs(mode: string): number {
  return Object.hasOwn(DIGEST_INTERVAL_MS, mode) ? DIGEST_INTERVAL_MS[mode as DigestMode] : DIGEST_INTERVAL_MS.daily;
}

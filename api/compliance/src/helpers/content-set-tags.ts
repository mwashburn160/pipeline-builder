// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `set:<x>` tag a curated (entitlement-gated) published rule carries, read
 * against api-core's {@link COMPLIANCE_SET_FEATURES} catalog — the one list of
 * content sets and the feature each requires.
 *
 * These were spelled in two services: the rule service's typo guard and the
 * subscription service's set readers each had their own `'set:'` prefix handling
 * and their own `new Set(COMPLIANCE_CONTENT_SETS)`, and the subscribe route
 * mapped a feature back to its set with a two-way ternary that a third set would
 * have read as `standard`.
 */

import { COMPLIANCE_CONTENT_SETS, COMPLIANCE_SET_FEATURES, type ComplianceContentSet, type FeatureFlag } from '@pipeline-builder/api-core';

const SET_TAG_PREFIX = 'set:';

/** The tag a rule in content set `set` carries (`set:standard`). */
export function setTagFor(set: ComplianceContentSet): string {
  return `${SET_TAG_PREFIX}${set}`;
}

function isKnownSet(name: string): name is ComplianceContentSet {
  return Object.hasOwn(COMPLIANCE_SET_FEATURES, name);
}

/** Coerce a jsonb `tags` column (unknown at the type level) to its string members. */
function tagsOf(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

/** Whether a rule's tags carry ANY `set:<x>` marker (curated/entitlement-gated), known or not. */
export function hasSetTag(tags: unknown): boolean {
  return tagsOf(tags).some((t) => t.startsWith(SET_TAG_PREFIX));
}

/** Distinct KNOWN content sets among a rule's `set:<x>` tags. */
export function setNamesFromTags(tags: unknown): ComplianceContentSet[] {
  const out = new Set<ComplianceContentSet>();
  for (const t of tagsOf(tags)) {
    if (!t.startsWith(SET_TAG_PREFIX)) continue;
    const name = t.slice(SET_TAG_PREFIX.length);
    if (isKnownSet(name)) out.add(name);
  }
  return [...out];
}

/**
 * The first `set:<x>` tag whose `<x>` is NOT a known content set, or null. A
 * typo'd `set:advance` would be invisible to the entitlement gate — enforced
 * for free to everyone AND absent from any paid library.
 */
export function unknownSetTag(tags: unknown): string | null {
  return tagsOf(tags).find((t) => t.startsWith(SET_TAG_PREFIX) && !isKnownSet(t.slice(SET_TAG_PREFIX.length))) ?? null;
}

/** Every valid set tag, for an error message. */
export function knownSetTags(): string[] {
  return COMPLIANCE_CONTENT_SETS.map(setTagFor);
}

/** The content set a curated-set feature unlocks (the inverse of `COMPLIANCE_SET_FEATURES`), or null. */
export function setForFeature(feature: FeatureFlag): ComplianceContentSet | null {
  return COMPLIANCE_CONTENT_SETS.find((set) => COMPLIANCE_SET_FEATURES[set] === feature) ?? null;
}

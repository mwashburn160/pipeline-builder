// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Docs-drift guard for the plan override family — the blind spot class.
 *
 * `packages/api-core/test/env-documented.test.ts` scans the shared readers
 * (`envInt` / `envStr` / `envBool`) for LITERAL names. Two kinds of knob escape
 * it, and both have shipped undocumented:
 *
 *  - read straight off `process.env` (how `PLUGIN_VULN_WAIVERS` went
 *    undocumented through many passes), and
 *  - built from a key, so no literal exists to match — these plan overrides.
 *
 * An env-file sweep does not cover them either, because they are OPTIONAL: each
 * has a default in `PLAN_SEED`, so `_NAME`, `_DESCRIPTION` and `_FEATURES`
 * appear in no deployment's `.env` at all. Nothing an operator can grep would
 * tell them these exist.
 *
 * So the check starts from the code's own declaration (`planEnvKeys()`) and
 * requires the document to cover every concrete name it expands to — either
 * literally or through a `{TIER}` pattern row, which is how a six-tier family is
 * documented without thirty near-identical rows.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import { VALID_TIERS } from '@pipeline-builder/api-core';
import { PLAN_ENV_SUFFIXES, planEnvKeys, planEnvName } from '../src/config/billing-config.js';

const DOC = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'environment-variables.md'), 'utf8');

/**
 * Names the document covers, with pattern rows expanded.
 *
 * A row may name `BILLING_PLAN_{TIER}_MONTHLY`; that covers the concrete
 * `BILLING_PLAN_PRO_MONTHLY` for every tier in the ladder. Suffix-only siblings
 * (`` `…_MONTHLY` / `_ANNUAL` ``) are written as a bare suffix in the same cell,
 * so a documented pattern prefix also covers its sibling suffixes.
 */
function documentedNames(): Set<string> {
  const names = new Set<string>();
  for (const raw of DOC.matchAll(/`([A-Z][A-Z0-9_]*\{TIER\}[A-Z0-9_]*|[A-Z][A-Z0-9_]{2,})`/g)) {
    const name = raw[1];
    if (name.includes('{TIER}')) {
      for (const tier of VALID_TIERS) names.add(name.replace('{TIER}', tier.toUpperCase()));
    } else {
      names.add(name);
    }
  }
  return names;
}

describe('BILLING_PLAN_{TIER}_* is documented', () => {
  it('expands to one name per tier per field', () => {
    // Guards a vacuous pass: an empty expansion would satisfy the assertion
    // below by checking nothing.
    const keys = planEnvKeys();
    expect(keys).toHaveLength(VALID_TIERS.length * PLAN_ENV_SUFFIXES.length);
    expect(keys).toContain('BILLING_PLAN_PRO_MONTHLY');
    expect(keys).toContain('BILLING_PLAN_UNLIMITED_FEATURES');
  });

  it('documents every name the loader reads', () => {
    const documented = documentedNames();
    // A pattern row covers the prefixed form; a cell naming the suffix alone
    // (`_ANNUAL` beside `BILLING_PLAN_{TIER}_MONTHLY`) covers the sibling.
    const suffixOnly = new Set(
      [...DOC.matchAll(/`_([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]),
    );
    const missing = planEnvKeys().filter((key) => {
      if (documented.has(key)) return false;
      const suffix = PLAN_ENV_SUFFIXES.find((s) => key.endsWith(`_${s}`));
      return !(suffix && suffixOnly.has(suffix));
    });
    expect(missing).toEqual([]);
  });

  it('names each tier in the ladder, so a new tier cannot be silently unpriced', () => {
    // The family is derived from VALID_TIERS, so adding a tier adds five names
    // at once. This fails until the document's own tier list mentions it.
    const undocumentedTiers = VALID_TIERS.filter(
      (tier) => !DOC.includes(planEnvName(tier, 'MONTHLY')) && !new RegExp(tier, 'i').test(DOC),
    );
    expect(undocumentedTiers).toEqual([]);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Docs-drift guard for the bundle and combo ID lists in `docs/billing-bundles.md`.
 *
 * Those lists are not decorative. They are the KEY to four live environment variables —
 * `BILLING_BUNDLE_<ID>_MONTHLY`, `_ANNUAL`, `_GRANT`, `_TIERS`, and
 * `BILLING_COMBO_<COMBO>_MONTHLY` / `_ANNUAL` — so an id missing from the page is an
 * override an operator cannot discover. That had already happened twice: the page listed
 * 12 of 14 bundles, omitting `STAKEHOLDER_REPORTS` (added with the reports add-on and
 * documented in the pricing table but never here) and `LISTING_PACK`. Anyone reading the
 * page would have concluded those two bundles' prices were not overridable.
 *
 * WHY THIS NEEDS ITS OWN GUARD. `env-documented.test.ts` already enforces that every var
 * read through `envInt` / `envBool` / `envStr` appears in the docs, and it cannot help
 * here: these names are BUILT by interpolating a bundle id, so no literal
 * `BILLING_BUNDLE_STAKEHOLDER_REPORTS_MONTHLY` exists anywhere for that guard to find.
 * A list assembled by hand from a catalog that grows needs a reader that compares the two.
 *
 * Asserted in BOTH directions. A missing id is the operator-facing bug; a leftover id is
 * the reviewer-facing one — it documents an override that silently does nothing, which is
 * worse than saying nothing at all.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';

// `src/config.ts` refuses to load without a Mongo URI when billing is on, and the imports
// below reach it. Nothing here touches a database — the reads are pure catalog — so the
// URI only has to EXIST. Set before the imports, because a static import would hoist
// above the assignment.
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/billing-bundle-docs';

const { getBundleCatalog } = await import('../src/helpers/billing-helpers.js');
const { getComboDiscounts } = await import('../src/helpers/combo-pricing.js');

/** Repo root, from `api/billing`. */
const DOC = join(import.meta.dirname, '..', '..', '..', 'docs', 'billing-bundles.md');

/** The ids in a `` `<ID>` is the bundle id upper-cased: `A`, `B`, … `` sentence. */
function documentedIds(doc: string, lead: string): string[] {
  const line = doc.split('\n').find((l) => l.startsWith(lead));
  if (!line) throw new Error(`docs/billing-bundles.md has no line starting "${lead}" — the guard cannot check the list`);
  return [...line.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]!);
}

describe('docs/billing-bundles.md lists every bundle and combo id', () => {
  const doc = readFileSync(DOC, 'utf8');

  it('names every purchasable bundle, and none that does not exist', () => {
    const shipped = getBundleCatalog().map((b) => b.id.toUpperCase()).sort();
    const documented = documentedIds(doc, '`<ID>` is the bundle id upper-cased').sort();
    expect({
      missingFromDocs: shipped.filter((id) => !documented.includes(id)),
      inDocsButNotShipped: documented.filter((id) => !shipped.includes(id)),
      fix: 'These ids are the key to BILLING_BUNDLE_<ID>_MONTHLY / _ANNUAL / _GRANT / _TIERS. '
        + 'An id missing from the page is an override nobody can find; one left behind documents '
        + 'an override that does nothing.',
    }).toMatchObject({ missingFromDocs: [], inDocsButNotShipped: [] });
  });

  it('names every combo id, and none that does not exist', () => {
    const shipped = getComboDiscounts().map((c) => c.id.toUpperCase()).sort();
    const documented = documentedIds(doc, '`<COMBO>` is the combo id upper-cased').sort();
    expect({
      missingFromDocs: shipped.filter((id) => !documented.includes(id)),
      inDocsButNotShipped: documented.filter((id) => !shipped.includes(id)),
      fix: 'These ids are the key to BILLING_COMBO_<COMBO>_MONTHLY / _ANNUAL.',
    }).toMatchObject({ missingFromDocs: [], inDocsButNotShipped: [] });
  });

  it('finds a non-trivial catalog (guards the guard)', () => {
    // A catalog that failed to load would make both assertions above vacuously true.
    expect(getBundleCatalog().length).toBeGreaterThan(10);
    expect(getComboDiscounts().length).toBeGreaterThan(2);
  });
});

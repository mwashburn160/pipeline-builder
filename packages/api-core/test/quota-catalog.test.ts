// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { QUOTA_TYPE_LABELS, VALID_QUOTA_TYPES, type QuotaType } from '../src/types/common.js';
import {
  NON_QUOTA_CONSUMABLE_CATALOG,
  QUOTA_CATALOG,
  quotaLabel,
  quotaLabelPlural,
  quotaAccrual,
  quotaDescription,
  quotaObservation,
  quotaPackUnit,
  quotaRender,
  type QuotaTypeMeta,
} from '../src/types/quota-catalog.js';

/**
 * The catalog is the single source for how every quota type is NAMED and
 * RENDERED, replacing six partial maps. `Record<QuotaType, …>` makes the
 * compiler demand an entry, but only against the types it can see: these
 * assertions pin the facts the type cannot state — that no label is blank, that
 * every byte quota carries a pack unit, and that the frontend's render switch
 * stays exhaustive — so a half-filled entry fails here rather than rendering
 * "" or "1 pack of bytes" to a customer.
 */
describe('QUOTA_CATALOG', () => {
  it('has an entry for every quota type and nothing else', () => {
    // The runtime list, not the type: a stale build or a cast can satisfy
    // `Record<QuotaType, …>` while the shipped object is missing a key.
    expect(Object.keys(QUOTA_CATALOG).sort()).toEqual([...VALID_QUOTA_TYPES].sort());
  });

  it.each(Object.entries(QUOTA_CATALOG))('%s is fully described', (type, meta: QuotaTypeMeta) => {
    expect(meta.label.trim().length).toBeGreaterThan(0);
    // Required, so a new type cannot fall back to the singular in plural
    // contexts — the partial-map trap the catalog exists to close.
    expect(meta.labelPlural.trim().length).toBeGreaterThan(0);
    expect(['count', 'bytes']).toContain(meta.render);
    expect(['flow', 'stock']).toContain(meta.accrual);
    expect(['metered', 'measured']).toContain(meta.observed);
    // The description's wording FOLLOWS from the accrual, so the two cannot
    // drift: a stock described as resetting "this period" is the exact error
    // the quotas page shipped for storage.
    if (meta.accrual === 'flow') {
      expect(meta.description).toMatch(/this period/);
    } else {
      expect(meta.description).not.toMatch(/this period/);
    }
    // What the counter counts — a display fact, so it lives here rather than in
    // whichever page happens to show it.
    expect(meta.description.trim().length).toBeGreaterThan(0);
    if (meta.packUnit) {
      expect(meta.packUnit.name.trim().length).toBeGreaterThan(0);
      // The divisor from raw grant to pack unit; zero or negative would divide
      // a pack size into Infinity or a negative step.
      expect(meta.packUnit.per).toBeGreaterThan(0);
      expect(Number.isInteger(meta.packUnit.per)).toBe(true);
    }
    expect(quotaLabel(type as QuotaType)).toBe(meta.label);
    expect(quotaLabelPlural(type as QuotaType)).toBe(meta.labelPlural);
    expect(quotaRender(type as QuotaType)).toBe(meta.render);
    expect(quotaPackUnit(type as QuotaType)).toEqual(meta.packUnit ?? null);
    expect(quotaDescription(type as QuotaType)).toBe(meta.description);
  });

  it('gives every byte-rendered quota a pack unit', () => {
    // Without one the add-on grid types pack COUNTS, so a storage pack would
    // read "1 pack" rather than "+10 GB" — the state `PACK_UNITS` was in.
    for (const [type, meta] of Object.entries(QUOTA_CATALOG)) {
      if (meta.render === 'bytes') expect(quotaPackUnit(type)).not.toBeNull();
    }
  });

  it('renders storage as bytes in GB packs', () => {
    expect(quotaRender('storageBytes')).toBe('bytes');
    expect(quotaPackUnit('storageBytes')).toEqual({ name: 'GB', per: 1024 ** 3 });
  });

  it('distinguishes singular from plural where the surface needs it', () => {
    // 429 bodies address one unit ("API call quota reached"); usage cards list
    // dimensions ("API calls"). Collapsing these shipped "API call" on a card.
    expect(quotaLabel('apiCalls')).toBe('API call');
    expect(quotaLabelPlural('apiCalls')).toBe('API calls');
  });

  it('describes seats, which render beside quotas but are not a quota type', () => {
    // Seats are a stock, not a per-period flow, so they are deliberately
    // outside `QuotaType` — but the billing usage card draws them in the same
    // list, and the label has to come from somewhere other than that one JSX.
    expect(Object.keys(NON_QUOTA_CONSUMABLE_CATALOG)).toEqual(['seats']);
    expect(quotaLabelPlural('seats')).toBe('Seats');
    expect(quotaLabel('seats')).toBe('Seat');
    expect(quotaRender('seats')).toBe('count');
    // Not a quota type: it must not leak into the quota-keyed surfaces.
    expect(QUOTA_CATALOG).not.toHaveProperty('seats');
    expect(VALID_QUOTA_TYPES as readonly string[]).not.toContain('seats');
    expect(QUOTA_TYPE_LABELS).not.toHaveProperty('seats');
  });

  it('knows which quotas refill and which persist', () => {
    // Flows reset on QUOTA_RESET_DAYS; stocks stay until the tenant frees them.
    // Getting this wrong told an organization its registry storage would reset.
    expect(quotaAccrual('apiCalls')).toBe('flow');
    expect(quotaAccrual('plugins')).toBe('flow');
    expect(quotaAccrual('storageBytes')).toBe('stock');
    // Counted at create time and decremented on delete — a level, not a rate.
    expect(quotaAccrual('dashboards')).toBe('stock');
    expect(quotaAccrual('idpConfigs')).toBe('stock');
    // Active publications, not publications-per-period.
    expect(quotaAccrual('listings')).toBe('stock');
    // Seats are the canonical stock, and the reason they are not a QuotaType.
    expect(quotaAccrual('seats')).toBe('stock');
    // An unfamiliar wire value reads as a flow — every metered quota is one.
    expect(quotaAccrual('buildMinutes')).toBe('flow');
  });

  it('keeps "is it a stock" separate from "who counts it"', () => {
    // These two do NOT line up, and conflating them silences quotas. The
    // create-time count caps are STOCKS that are nonetheless METERED — a
    // notifier keyed on accrual instead of observation would have stopped
    // notifying every one of them.
    expect(quotaAccrual('dashboards')).toBe('stock');
    expect(quotaObservation('dashboards')).toBe('metered');
    expect(quotaAccrual('listings')).toBe('stock');
    expect(quotaObservation('listings')).toBe('metered');
    // Storage is the ONLY measured quota type: nothing increments it, the
    // registry walks its own catalog on demand.
    const measured = Object.entries(QUOTA_CATALOG).filter(([, m]) => m.observed === 'measured').map(([t]) => t);
    expect(measured).toEqual(['storageBytes']);
    // Seats are measured too — counted live at invite time — which is part of
    // why they are not a QuotaType.
    expect(quotaObservation('seats')).toBe('measured');
    expect(quotaObservation('buildMinutes')).toBe('metered');
  });

  it('describes each quota with its REAL semantics, not a house style', () => {
    // The three shapes are genuinely different, and the wording has to match or
    // it teaches the wrong model. Per-period flows say "this period" (deleting
    // the entity does not refund the slot); create-time counts that decrement on
    // delete say "currently"; measured storage is neither.
    expect(quotaDescription('pipelines')).toMatch(/this period/);
    expect(quotaDescription('plugins')).toMatch(/this period/);
    expect(quotaDescription('dashboards')).toMatch(/currently/);
    expect(quotaDescription('storageBytes')).not.toMatch(/this period/);
  });

  it('tells a personal-access-key holder which budget they spend', () => {
    // `meteredQuotaTypeFor` sends `token_use: 'api_key'` and anything minted
    // while holding one to automationCalls. The quotas page used to describe
    // automationCalls as service accounts only, so a PAT holder read it and
    // concluded they were spending apiCalls.
    expect(quotaDescription('automationCalls')).toMatch(/personal access/i);
    expect(quotaDescription('apiCalls')).not.toMatch(/personal access/i);
  });

  it('degrades to the raw key for a type outside the catalog', () => {
    // Quota types arrive from the wire (a 429 body, a quota response), where an
    // unknown value must render as something rather than crash a page.
    expect(quotaLabel('buildMinutes')).toBe('buildMinutes');
    expect(quotaLabelPlural('buildMinutes')).toBe('buildMinutes');
    expect(quotaRender('buildMinutes')).toBe('count');
    expect(quotaDescription('buildMinutes')).toBe('');
    expect(quotaPackUnit('buildMinutes')).toBeNull();
  });

  it('is the source QUOTA_TYPE_LABELS derives from', () => {
    expect(QUOTA_TYPE_LABELS).toEqual(
      Object.fromEntries(Object.entries(QUOTA_CATALOG).map(([type, meta]) => [type, meta.label])),
    );
  });
});

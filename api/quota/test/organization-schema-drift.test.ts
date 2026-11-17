// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard: quota's `Organization` model vs the platform-AUTHORITATIVE one.
 *
 * Both are Mongoose views over the same `organizations` collection
 * (models/organization.ts SCOPE note). Platform creates every org; quota reads
 * and moves the counters. A path the two declare differently is a silent bug —
 * a type that casts differently, a default one side persists and the other
 * does not, an index one side creates and the other reports as unknown at
 * every boot (platform's utils/index-reconcile.ts). So this loads BOTH schemas
 * (in memory, no database) and compares every path quota owns: `quotas.*`,
 * `usage.*`, `poolUsage.*`, `tier`, `parentOrgId`, `deletedAt`.
 *
 * The differences that exist today are deliberate or known, and each is
 * PINNED below with its reason rather than skipped — so a new divergence (or
 * one of these quietly going away) fails here instead of in production.
 */

import { describe, expect, it } from '@jest/globals';
import mongoose, { type Schema, type SchemaType } from 'mongoose';

process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const { Organization: QuotaOrganization } = await import('../src/models/organization.js');
// Both modules register the model name `Organization` on the one shared
// Mongoose instance; quota's is captured above, so free the name for platform's.
mongoose.deleteModel('Organization');
// A non-literal specifier on purpose: tsc must not pull platform's sources into
// this project (they sit outside its rootDir); jest resolves it at run time.
const PLATFORM_MODEL = '../../../platform/src/models/organization.js';
const { default: PlatformOrganization } = await import(PLATFORM_MODEL) as { default: { schema: Schema } };

const quotaSchema = QuotaOrganization.schema;
const platformSchema = PlatformOrganization.schema;

/** The paths this service owns on the shared document. */
const QUOTA_OWNED = /^(quotas\.|usage\.|poolUsage\.|tier$|parentOrgId$|deletedAt$)/;

type AnySchemaType = SchemaType & { defaultValue?: unknown; enumValues?: string[]; schema?: Schema };

function ownedPaths(schema: Schema): Map<string, AnySchemaType> {
  const out = new Map<string, AnySchemaType>();
  schema.eachPath((p, t) => { if (QUOTA_OWNED.test(p)) out.set(p, t as AnySchemaType); });
  return out;
}

const quotaPaths = ownedPaths(quotaSchema);
const platformPaths = ownedPaths(platformSchema);

/** A path's sub-document fields → their types (empty for a leaf). */
const subTypes = (t: AnySchemaType): Record<string, string> =>
  Object.fromEntries(Object.entries(t.schema?.paths ?? {}).map(([k, v]) => [k, v.instance]));

/** A default as a comparable value: a function default is evaluated. */
const evalDefault = (t: AnySchemaType): unknown => (typeof t.defaultValue === 'function' ? (t.defaultValue as () => unknown)() : t.defaultValue);

/**
 * Quota-owned paths platform does not declare. Platform never READS them, and
 * writes the counters only through quota's API, so the absence is harmless
 * until platform starts reseeding them — at which point it must declare them.
 *  - the six count-quota usage counters platform does not seed;
 *  - `poolUsage.*`, the root's pooled counter, which only quota writes.
 */
const PLATFORM_UNDECLARED = [
  'usage.storageBytes', 'usage.dashboards', 'usage.alertRules', 'usage.alertDestinations', 'usage.idpConfigs', 'usage.listings',
  ...[...quotaPaths.keys()].filter((p) => p.startsWith('poolUsage.')),
].sort();

describe('quota vs platform Organization schema', () => {
  it('declares every quota-owned path platform declares (platform-only `quotas.*` are platform-owned limits)', () => {
    const platformOnly = [...platformPaths.keys()].filter((p) => !quotaPaths.has(p)).sort();
    // seats / support contacts are enforced live by platform at invite / designation
    // time; they are not quota types (VALID_QUOTA_TYPES) and quota never reads them.
    expect(platformOnly).toEqual(['quotas.seats', 'quotas.supportContacts', 'quotas.supportPremiumContacts']);
  });

  it('pins the quota-owned paths platform does not declare', () => {
    const undeclared = [...quotaPaths.keys()].filter((p) => !platformPaths.has(p)).sort();
    expect(undeclared).toEqual(PLATFORM_UNDECLARED);
    expect(PLATFORM_UNDECLARED.filter((p) => p.startsWith('poolUsage.')).length).toBeGreaterThan(0);
  });

  it('gives every shared path the same type', () => {
    const mismatched = [...quotaPaths].filter(([p, t]) => platformPaths.has(p) && platformPaths.get(p)!.instance !== t.instance)
      .map(([p, t]) => `${p}: quota ${t.instance} / platform ${platformPaths.get(p)!.instance}`);
    expect(mismatched).toEqual([]);
  });

  it('gives every shared usage counter the same sub-document, plus quota\'s `limitAtPeriodStart`', () => {
    for (const [p, t] of quotaPaths) {
      if (!p.startsWith('usage.') || !platformPaths.has(p)) continue;
      const quotaSub = subTypes(t);
      const platformSub = subTypes(platformPaths.get(p)!);
      // `limitAtPeriodStart` is quota's period-boundary cap snapshot (written by the
      // reset); platform does not declare it, so a platform-side reseed of a
      // counter replaces the sub-document without it — reads as "no snapshot".
      const { limitAtPeriodStart, ...shared } = quotaSub;
      expect({ p, limitAtPeriodStart }).toEqual({ p, limitAtPeriodStart: 'Number' });
      expect({ p, sub: shared }).toEqual({ p, sub: platformSub });
    }
  });

  it('agrees on the scalar defaults and the tier vocabulary', () => {
    for (const p of ['tier', 'parentOrgId', 'deletedAt']) {
      expect({ p, def: evalDefault(quotaPaths.get(p)!) }).toEqual({ p, def: evalDefault(platformPaths.get(p)!) });
    }
    expect([...(quotaPaths.get('tier')!.enumValues ?? [])].sort()).toEqual([...(platformPaths.get('tier')!.enumValues ?? [])].sort());
  });

  it('seeds the same fresh counter for every shared usage type (same period, zero used)', () => {
    for (const [p, t] of quotaPaths) {
      if (!p.startsWith('usage.') || !platformPaths.has(p)) continue;
      const q = evalDefault(t) as { used: number; resetAt: Date };
      const pl = evalDefault(platformPaths.get(p)!) as { used: number; resetAt: Date };
      expect({ p, used: q.used }).toEqual({ p, used: pl.used });
      // Same period: the two resets land within a minute of each other.
      expect({ p, apart: Math.abs(new Date(q.resetAt).getTime() - new Date(pl.resetAt).getTime()) < 60_000 }).toEqual({ p, apart: true });
    }
  });

  it('pins the deliberate `quotas.*` default split: platform seeds the default tier, quota declares none', () => {
    // models/organization.ts SCOPE: a static default here would be persisted onto
    // a hydrated org by its next save(), pinning it to the default tier's cap. An
    // absent limit is resolved at read time from the org's tier instead.
    for (const [p, t] of quotaPaths) {
      if (!p.startsWith('quotas.')) continue;
      expect({ p, quotaDefault: t.defaultValue }).toEqual({ p, quotaDefault: undefined });
      expect({ p, platformDefaults: typeof platformPaths.get(p)?.defaultValue }).toEqual({ p, platformDefaults: 'function' });
    }
  });

  it('pins the index drift on the shared collection', () => {
    const key = (i: [Record<string, unknown>, Record<string, unknown>]) => JSON.stringify(i[0]);
    const platformKeys = new Set(platformSchema.indexes().map((i) => key(i as never)));
    const quotaOnly = quotaSchema.indexes().map((i) => key(i as never)).filter((k) => !platformKeys.has(k));
    // `name_1` backs quota's admin list (`findAll` sorts by `{ name: 1, _id: 1 }`);
    // platform now declares it too, so its boot index-reconcile no longer reports
    // it as unknown. Every quota index must exist in platform's schema.
    expect(quotaOnly).toEqual([]);
    // Platform's sparse `deletedAt` index (its purge sweep) is platform's alone;
    // quota's live-only filters ride on it without redeclaring it.
    expect(platformKeys.has(JSON.stringify({ deletedAt: 1 }))).toBe(true);
  });
});

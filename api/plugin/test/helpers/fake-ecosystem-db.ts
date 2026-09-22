// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory stand-in for the slice of drizzle the ecosystem services use
 * (`src/services/ecosystem/store.ts`): select / insert / update / delete over
 * named tables, with `eq` / `and` / `inArray` / `isNull` / `gte` / `like`
 * predicates and `desc` ordering. Tables are plain arrays the
 * test can seed and inspect.
 *
 * Usage (before importing any module under test):
 *   const db = createFakeEcosystemDb();
 *   jest.unstable_mockModule('drizzle-orm', () => drizzleMock(db.ops));
 *   jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({ ...actual, ...db.pipelineData }));
 */

import { randomUUID } from 'node:crypto';

/** A stored row (every row has an id once inserted). */
export type Row = { id: string; [column: string]: any };
/** Values to insert. */
export type NewRow = Record<string, any>;
type Col = { __table: string; __col: string };
type Cond =
  | { op: 'eq' | 'gte' | 'like'; col: Col; value: unknown }
  | { op: 'in'; col: Col; value: unknown[] }
  | { op: 'isNull'; col: Col }
  | { op: 'and'; parts: Array<Cond | undefined> };
type Order = { dir: 'desc'; col: Col };

/** Column defaults per table (applied on insert). */
const DEFAULTS: Record<string, () => NewRow> = {
  publishers: () => ({
    ownerOrgId: null,
    description: null,
    homepageUrl: null,
    tier: 'community',
    verifiedAt: null,
    verifiedGraceUntil: null,
    termsVersion: null,
    termsAcceptedAt: null,
    suspendedAt: null,
    suspendReason: null,
    successRate30d: null,
    healthScore: null,
  }),
  plugin_listings: () => ({
    category: 'unknown',
    summary: null,
    description: null,
    readmeHtml: null,
    license: null,
    homepageUrl: null,
    sourceUrl: null,
    icon: null,
    uploadedIcon: null,
    keywords: [],
    state: 'listed',
    pausedAt: null,
    featured: false,
    latestVersion: null,
  }),
  plugin_listing_versions: () => ({
    sourcePluginId: null,
    imageDigest: null,
    imageRepository: null,
    specSnapshot: {},
    breaking: false,
    pausedAt: null,
    yankedAt: null,
    yankReason: null,
    deprecatedAt: null,
    deprecationMessage: null,
    changelog: null,
    vulnCritical: null,
    vulnHigh: null,
    scannedAt: null,
    baseImageCreatedAt: null,
    publishedAt: new Date(),
  }),
  plugin_publish_requests: () => ({
    listingId: null,
    pluginId: null,
    version: null,
    digest: null,
    securityFixAdvisoryId: null,
    payload: {},
    status: 'pending',
    lane: 'standard',
    submittedOrgId: null,
    firstApprovedBy: null,
    decidedBy: null,
    secondApprovedBy: null,
    reason: null,
    autoRuleId: null,
    decidedAt: null,
  }),
  ecosystem_auto_approval_rules: () => ({ enabled: false, conditions: {}, approvedBy: null, pendingChange: null }),
  ecosystem_reserved_names: () => ({ reason: null, publisherId: null }),
  ecosystem_settings: () => ({ updatedBy: null }),
  plugin_advisories: () => ({
    state: 'draft', fixedVersion: null, detailsMd: null, detailsHtml: null, cveIds: [], publishedBy: null, publishedAt: null, withdrawnAt: null,
  }),
  plugins: () => ({ deletedAt: null, frozenAt: null }),
  plugin_installs: () => ({ versionPolicy: 'minor', pinnedVersion: null, resolvedVersion: null, status: 'active', approvedBy: null, decidedAt: null }),
  plugin_reviews: () => ({
    version: null,
    title: null,
    bodyMd: null,
    bodyHtml: null,
    authorDisplayName: null,
    verifiedUse: false,
    status: 'published',
    holdReason: null,
    moderationReason: null,
    helpfulCount: 0,
  }),
  plugin_review_reports: () => ({ category: 'abuse', reason: null, resolvedAt: null }),
  plugin_stats: () => ({
    ratingBayes: null,
    ratingCount: 0,
    dist: {},
    recentRating: null,
    installCount: 0,
    activeOrgCount: 0,
    successRate30d: null,
    healthScore: null,
    healthBreakdown: null,
  }),
  plugin_submissions: () => ({
    status: 'pending_verification',
    emailHash: null,
    emailEnc: null,
    verifyTokenHash: null,
    verifyExpiresAt: null,
    verifiedAt: null,
    statusTokenHash: null,
    spec: {},
    catalog: { values: {}, sources: {} },
    dockerfile: null,
    artifactKey: null,
    quarantineImageRef: null,
    gateReport: null,
    heuristics: null,
    listingId: null,
    decidedBy: null,
    reason: null,
    clientIpHash: null,
    decidedAt: null,
    emailPurgeAfter: null,
  }),
  plugin_install_policies: () => ({
    allowedTiers: ['official', 'verified'],
    requireApprovalTiers: ['community', 'unverified'],
    secretsAllowedTiers: ['official', 'verified'],
    blockOnAdvisory: 'critical',
    officialInstalls: 'implicit',
    blockedListings: [],
    updatedBy: null,
  }),
};

/** drizzle table key → SQL table name. */
export const TABLES = {
  publisher: 'publishers',
  pluginListing: 'plugin_listings',
  pluginListingVersion: 'plugin_listing_versions',
  pluginPublishRequest: 'plugin_publish_requests',
  ecosystemAutoApprovalRule: 'ecosystem_auto_approval_rules',
  ecosystemReservedName: 'ecosystem_reserved_names',
  ecosystemSetting: 'ecosystem_settings',
  pluginAdvisory: 'plugin_advisories',
  pluginAdvisoryDelivery: 'plugin_advisory_deliveries',
  plugin: 'plugins',
  pluginInstall: 'plugin_installs',
  pluginInstallPolicy: 'plugin_install_policies',
  pluginReview: 'plugin_reviews',
  pluginReviewReply: 'plugin_review_replies',
  pluginReviewReport: 'plugin_review_reports',
  pluginReviewVote: 'plugin_review_votes',
  pluginReviewHistory: 'plugin_review_history',
  pluginStats: 'plugin_stats',
  pluginSubmission: 'plugin_submissions',
} as const;

function tableObject(name: string): Record<string, unknown> {
  return new Proxy({ __tableName: name } as Record<string, unknown>, {
    get: (target, prop) => (prop === '__tableName' ? target.__tableName : { __table: name, __col: String(prop) }),
  });
}

function matches(row: Row, c: Cond | undefined): boolean {
  if (!c) return true;
  switch (c.op) {
    case 'and': return c.parts.every((p) => matches(row, p));
    case 'eq': return row[c.col.__col] === c.value;
    case 'isNull': return row[c.col.__col] === null || row[c.col.__col] === undefined;
    case 'in': return c.value.includes(row[c.col.__col]);
    case 'gte': {
      const v = row[c.col.__col];
      return v !== null && v !== undefined && new Date(v).getTime() >= new Date(c.value as Date).getTime();
    }
    case 'like': return String(row[c.col.__col]).startsWith(String(c.value).replace(/%$/, ''));
  }
}

function sortRows(rows: Row[], orders: Order[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const o of orders) {
      const av = a[o.col.__col];
      const bv = b[o.col.__col];
      const x = av instanceof Date ? av.getTime() : av;
      const y = bv instanceof Date ? bv.getTime() : bv;
      if (x === y) continue;
      return x < y ? 1 : -1;
    }
    return 0;
  });
}

export interface FakeEcosystemDb {
  tables: Record<string, Row[]>;
  /** drizzle-orm operator overrides. */
  ops: Record<string, unknown>;
  /** pipeline-data overrides: `schema`, `withTenantTx`, `runWithTenantContext`. */
  pipelineData: Record<string, unknown>;
  /** Insert a row with defaults (returns it). */
  seed: (table: string, row: NewRow) => Row;
  reset: () => void;
  /** Make the next insert into `table` throw this error. */
  failNextInsert: (table: string, err: unknown) => void;
  /** Raw `tx.execute(sql…)` calls: the handler answers each (default: no rows). */
  execute: { handler: (query: unknown) => unknown; calls: unknown[] };
}

export function createFakeEcosystemDb(): FakeEcosystemDb {
  const tables: Record<string, Row[]> = {};
  const failures = new Map<string, unknown>();
  const table = (name: string) => (tables[name] ??= []);

  const withDefaults = (name: string, row: NewRow): Row => {
    const now = new Date();
    return { id: randomUUID(), createdAt: now, updatedAt: now, ...(DEFAULTS[name]?.() ?? {}), ...row };
  };

  const seed = (name: string, row: NewRow): Row => {
    const full = withDefaults(name, row);
    table(name).push(full);
    return full;
  };

  const tableName = (t: unknown) => (t as { __tableName: string }).__tableName;

  function query(name: string, fields?: Record<string, Col>) {
    let where: Cond | undefined;
    let orders: Order[] = [];
    let max = Infinity;
    const run = () => {
      const rows = sortRows(table(name).filter((r) => matches(r, where)), orders).slice(0, max);
      return rows.map((r) => (fields ? Object.fromEntries(Object.entries(fields).map(([k, c]) => [k, r[c.__col]])) : { ...r }));
    };
    const q: any = {
      where: (c: Cond) => { where = c; return q; },
      orderBy: (...o: Order[]) => { orders = o; return q; },
      limit: (n: number) => { max = n; return q; },
      then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  }

  const execute = { handler: (_q: unknown): unknown => ({ rows: [] }), calls: [] as unknown[] };
  const tx = {
    execute: async (q: unknown) => { execute.calls.push(q); return execute.handler(q); },
    select: (fields?: Record<string, Col>) => ({ from: (t: unknown) => query(tableName(t), fields) }),
    insert: (t: unknown) => ({
      values: (v: NewRow) => {
        const name = tableName(t);
        const doInsert = () => {
          if (failures.has(name)) {
            const err = failures.get(name);
            failures.delete(name);
            throw err;
          }
          return seed(name, v);
        };
        const inserted: any = {
          returning: async () => [{ ...doInsert() }],
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(doInsert).then(resolve, reject),
        };
        return inserted;
      },
    }),
    update: (t: unknown) => ({
      set: (patch: NewRow) => ({
        where: (c: Cond) => {
          const apply = () => {
            const hit = table(tableName(t)).filter((r) => matches(r, c));
            for (const r of hit) Object.assign(r, patch);
            return hit.map((r) => ({ ...r }));
          };
          const u: any = {
            returning: async () => apply(),
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(apply).then(resolve, reject),
          };
          return u;
        },
      }),
    }),
    delete: (t: unknown) => ({
      where: (c: Cond) => {
        const apply = () => {
          const name = tableName(t);
          const removed = table(name).filter((r) => matches(r, c));
          tables[name] = table(name).filter((r) => !matches(r, c));
          return removed;
        };
        const d: any = {
          returning: async () => apply(),
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(apply).then(resolve, reject),
        };
        return d;
      },
    }),
  };

  const schema = Object.fromEntries(Object.entries(TABLES).map(([key, name]) => [key, tableObject(name)]));

  return {
    tables,
    ops: {
      eq: (col: Col, value: unknown) => ({ op: 'eq', col, value }),
      gte: (col: Col, value: unknown) => ({ op: 'gte', col, value }),
      like: (col: Col, value: unknown) => ({ op: 'like', col, value }),
      inArray: (col: Col, value: unknown[]) => ({ op: 'in', col, value }),
      isNull: (col: Col) => ({ op: 'isNull', col }),
      and: (...parts: Cond[]) => ({ op: 'and', parts }),
      desc: (col: Col) => ({ dir: 'desc', col }),
    },
    pipelineData: {
      schema,
      withTenantTx: (fn: (t: typeof tx) => unknown) => fn(tx),
      runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
    },
    seed,
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      failures.clear();
      execute.handler = () => ({ rows: [] });
      execute.calls.length = 0;
    },
    execute,
    failNextInsert: (name, err) => { failures.set(name, err); },
  };
}

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
 *   const db = createFakeEcosystemDb;
 *   jest.unstable_mockModule('drizzle-orm', => drizzleMock(db.ops));
 *   jest.unstable_mockModule('@pipeline-builder/pipeline-data', => ({...actual,...db.pipelineData }));
 */

import { randomUUID } from 'node:crypto';

/** A stored row (every row has an id once inserted). */
export type Row = { id: string; [column: string]: any };
/** Values to insert. */
export type NewRow = Record<string, any>;
type Col = { __table: string; __col: string };
type Cond =
  | { op: 'eq' | 'ne' | 'gte' | 'gt' | 'lte' | 'lt' | 'like'; col: Col; value: unknown }
  | { op: 'in'; col: Col; value: unknown[] }
  | { op: 'isNull' | 'isNotNull'; col: Col }
  | { op: 'and' | 'or'; parts: Array<Cond | undefined> };
type Order = { dir: 'desc' | 'asc'; col: Col };
/** `count()` in a select's field map. */
type Agg = { __agg: 'count' };

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
  plugin_installs: () => ({ versionPolicy: 'minor', pinnedVersion: null, resolvedVersion: null, status: 'active', approvedBy: null, decidedAt: null, pendingChange: null }),
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

/** Comparable form of a cell / operand (dates compare by time). */
const cmpValue = (v: unknown): unknown => (v instanceof Date ? v.getTime() : v);

function compare(row: Row, c: { col: Col; value: unknown }, ok: (a: any, b: any) => boolean): boolean {
  const v = row[c.col.__col];
  if (v === null || v === undefined) return false;
  const a = v instanceof Date || c.value instanceof Date ? new Date(v).getTime() : v;
  const b = c.value instanceof Date ? c.value.getTime() : cmpValue(c.value);
  return ok(a, b);
}

/** The jsonb-path predicate store.ts builds (`jsonPathEq`): its parts ride on the SQL object. */
type JsonPathEq = { jsonPathEq: { column: Col; path: string[]; value: string } };

function matches(row: Row, c: Cond | undefined): boolean {
  if (!c) return true;
  const jp = (c as unknown as Partial<JsonPathEq>).jsonPathEq;
  if (jp) {
    let v: unknown = row[jp.column.__col];
    for (const key of jp.path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
    return v !== undefined && v !== null && String(v) === jp.value;
  }
  switch (c.op) {
    case 'and': return c.parts.every((p) => matches(row, p));
    case 'or': return c.parts.some((p) => p !== undefined && matches(row, p));
    case 'eq': return cmpValue(row[c.col.__col]) === cmpValue(c.value);
    case 'ne': return cmpValue(row[c.col.__col]) !== cmpValue(c.value);
    case 'isNull': return row[c.col.__col] === null || row[c.col.__col] === undefined;
    case 'isNotNull': return row[c.col.__col] !== null && row[c.col.__col] !== undefined;
    case 'in': return c.value.includes(row[c.col.__col]);
    case 'gte': return compare(row, c, (a, b) => a >= b);
    case 'gt': return compare(row, c, (a, b) => a > b);
    case 'lte': return compare(row, c, (a, b) => a <= b);
    case 'lt': return compare(row, c, (a, b) => a < b);
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
      if (o.dir === 'asc') return x < y ? -1 : 1;
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
  /** Make the next select from `table` throw this error. */
  failNextSelect: (table: string, err: unknown) => void;
  /** Raw `tx.execute(sql…)` calls: the handler answers each (default: no rows). */
  execute: { handler: (query: unknown) => unknown; calls: unknown[] };
}

export function createFakeEcosystemDb(): FakeEcosystemDb {
  const tables: Record<string, Row[]> = {};
  const failures = new Map<string, unknown>();
  const selectFailures = new Map<string, unknown>();
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

  /** Every table's rows (by identity) with a copy of each as the transaction found it. */
  type Snapshot = Map<string, Map<Row, Row>>;
  const openTxs = new Set<Snapshot>();
  /** Fold what the committed transaction (`done`) changed into a still-open one's snapshot. */
  const foldCommit = (done: Snapshot, open: Snapshot) => {
    for (const [name, rows] of Object.entries(tables)) {
      const before = done.get(name) ?? new Map<Row, Row>();
      const target = open.get(name) ?? new Map<Row, Row>();
      open.set(name, target);
      const now = new Set(rows);
      for (const ref of rows) {
        const was = before.get(ref);
        const changed = !was || Object.keys({ ...was, ...ref }).some((k) => was[k] !== ref[k]);
        if (changed) target.set(ref, { ...ref });
      }
      for (const ref of before.keys()) if (!now.has(ref)) target.delete(ref);
    }
  };

  const tableName = (t: unknown) => (t as { __tableName: string }).__tableName;

  function query(name: string, fields?: Record<string, Col | Agg>) {
    let where: Cond | undefined;
    let orders: Order[] = [];
    let max = Infinity;
    let skip = 0;
    const run = () => {
      const failure = selectFailures.get(name);
      if (failure !== undefined) {
        selectFailures.delete(name);
        throw failure;
      }
      const hit = table(name).filter((r) => matches(r, where));
      // An aggregate select (`{ n: count() }`) answers one row over the whole match.
      if (fields && Object.values(fields).some((f) => '__agg' in f)) {
        return [Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, '__agg' in f ? hit.length : undefined]))];
      }
      const rows = sortRows(hit, orders).slice(skip, skip + max);
      return rows.map((r) => (fields ? Object.fromEntries(Object.entries(fields).map(([k, c]) => [k, r[(c as Col).__col]])) : { ...r }));
    };
    const q: any = {
      where: (c: Cond) => { where = c; return q; },
      orderBy: (...o: Order[]) => { orders = o; return q; },
      limit: (n: number) => { max = n; return q; },
      offset: (n: number) => { skip = n; return q; },
      // Row locks (`SELECT … FOR UPDATE`) are a no-op in memory: the fake is single-threaded.
      for: () => q,
      then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  }

  const execute = { handler: (_q: unknown): unknown => ({ rows: [] }), calls: [] as unknown[] };
  const tx = {
    execute: async (q: unknown) => { execute.calls.push(q); return execute.handler(q); },
    select: (fields?: Record<string, Col | Agg>) => ({ from: (t: unknown) => query(tableName(t), fields) }),
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
      ne: (col: Col, value: unknown) => ({ op: 'ne', col, value }),
      gte: (col: Col, value: unknown) => ({ op: 'gte', col, value }),
      gt: (col: Col, value: unknown) => ({ op: 'gt', col, value }),
      lte: (col: Col, value: unknown) => ({ op: 'lte', col, value }),
      lt: (col: Col, value: unknown) => ({ op: 'lt', col, value }),
      or: (...parts: Cond[]) => ({ op: 'or', parts }),
      isNotNull: (col: Col) => ({ op: 'isNotNull', col }),
      asc: (col: Col) => ({ dir: 'asc', col }),
      count: (): Agg => ({ __agg: 'count' }),
      like: (col: Col, value: unknown) => ({ op: 'like', col, value }),
      inArray: (col: Col, value: unknown[]) => ({ op: 'in', col, value }),
      isNull: (col: Col) => ({ op: 'isNull', col }),
      and: (...parts: Cond[]) => ({ op: 'and', parts }),
      desc: (col: Col) => ({ dir: 'desc', col }),
    },
    pipelineData: {
      schema,
      // A transaction: a throw out of `fn` rolls every table back to where it
      // was (row objects are restored IN PLACE, so a test's references stay live).
      // Transactions are INDEPENDENT, as in Postgres: one that commits while
      // another is open is folded into the other's snapshot, so the other's
      // rollback cannot undo it — a store call that opens its own transaction
      // instead of joining the ambient one persists even when that one fails.
      withTenantTx: async (fn: (t: typeof tx) => unknown) => {
        const snap: Snapshot = new Map(Object.entries(tables).map(([name, rows]) => [name, new Map(rows.map((r) => [r, { ...r }]))]));
        openTxs.add(snap);
        try {
          const out = await fn(tx);
          openTxs.delete(snap);
          for (const other of openTxs) foldCommit(snap, other);
          return out;
        } catch (err) {
          openTxs.delete(snap);
          for (const name of Object.keys(tables)) if (!snap.has(name)) delete tables[name];
          for (const [name, rows] of snap) {
            tables[name] = [...rows].map(([ref, copy]) => {
              for (const k of Object.keys(ref)) if (!(k in copy)) delete ref[k];
              return Object.assign(ref, copy);
            });
          }
          throw err;
        }
      },
      runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
    },
    seed,
    reset: () => {
      for (const k of Object.keys(tables)) delete tables[k];
      failures.clear();
      selectFailures.clear();
      execute.handler = () => ({ rows: [] });
      execute.calls.length = 0;
    },
    execute,
    failNextInsert: (name, err) => { failures.set(name, err); },
    failNextSelect: (name, err) => { selectFailures.set(name, err); },
  };
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `plugin_remediations` / `plugin_remediation_settings` access. Every table
 * here is OWN-ORG ONLY under RLS, and the job, the nightly queueing and the
 * internal report act on rows of any org — so those run ELEVATED (sysadmin
 * tenant context) with explicit org predicates. Route reads pass the caller's
 * org and run elevated too, always filtered by it.
 */

import {
  ACTIVE_BUILD_REMEDIATION_STAGES,
  compareSemverLenient,
  createLogger,
  LIVE_REMEDIATION_STAGES,
  normalizePluginRemediationSettings,
  SYSTEM_PLUGIN_REMEDIATION,
  type PluginRemediationSettings,
  type PluginRemediationStage,
} from '@pipeline-builder/api-core';
import {
  runWithTenantContext,
  schema,
  withTenantTx,
  type Plugin,
  type PluginRemediation,
  type PluginRemediationInsert,
  type PluginRemediationSettingRow,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

/**
 * After publish and still live: the pipeline service is (or was) rolling the fix out, so a
 * report moves it and a cancel must stop the rollout. (LIVE minus ACTIVE_BUILD.)
 */
export const ROLLOUT_REMEDIATION_STAGES = LIVE_REMEDIATION_STAGES.filter(
  (s) => !(ACTIVE_BUILD_REMEDIATION_STAGES as readonly string[]).includes(s),
) as ReadonlyArray<Exclude<(typeof LIVE_REMEDIATION_STAGES)[number], (typeof ACTIVE_BUILD_REMEDIATION_STAGES)[number]>>;
export const isRolloutStage = (stage: PluginRemediationStage): boolean => (ROLLOUT_REMEDIATION_STAGES as readonly string[]).includes(stage);

const logger = createLogger('plugin-remediation-store');

const R = () => schema.pluginRemediation;
const S = () => schema.pluginRemediationSetting;
const P = () => schema.plugin;

/** Run `fn` in one transaction under a sysadmin tenant context (explicit org predicates only). */
export function elevatedTx<T>(fn: (tx: any) => Promise<T>): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));
}

export async function getRemediation(id: string): Promise<PluginRemediation | null> {
  if (!UUID.test(id)) return null;
  const rows = await elevatedTx((tx) => tx.select().from(R()).where(eq(R().id, id)).limit(1)) as PluginRemediation[];
  return rows[0] ?? null;
}

/** A remediation of `orgId` (null for another org's: the routes answer 404). */
export async function getOrgRemediation(orgId: string, id: string): Promise<PluginRemediation | null> {
  const row = await getRemediation(id);
  return row && row.orgId.toLowerCase() === orgId.toLowerCase() ? row : null;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the versions a remediation row names — `plugin_id` (the version it
 * fixes) and `to_plugin_id` (its fix), when set — exist and belong to the row's
 * own org. Every table here is written elevated, so RLS never catches a row of
 * one org pointing at another org's version; this does, before any insert.
 * (The system org's Official flows are no exception: their rows are the system
 * org's, and so are the versions they fix and publish.) `plugin_id` is nullable
 * only so a fix record outlives its version's purge: an insert always names one.
 */
async function pluginsBelongToRowOrg(tx: any, row: Pick<PluginRemediationInsert, 'orgId' | 'pluginId' | 'toPluginId'>): Promise<boolean> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (typeof row.pluginId !== 'string' || row.pluginId.length === 0) return false;
  const ids = [...new Set([row.pluginId, row.toPluginId].filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (ids.some((x) => !UUID.test(x))) return false;
  const found = await tx.select({ id: P().id, orgId: P().orgId }).from(P()).where(inArray(P().id, ids)) as Array<{ id: string; orgId: string }>;
  const org = row.orgId.toLowerCase();
  return found.length === ids.length && found.every((f) => f.orgId.toLowerCase() === org);
}

function logRefusedInsert(row: Pick<PluginRemediationInsert, 'orgId' | 'pluginId' | 'toPluginId'>): void {
  logger.error('Remediation insert refused: a version it names is not the row\'s org', { orgId: row.orgId, pluginId: row.pluginId, toPluginId: row.toPluginId ?? null });
}

/**
 * Insert a queued remediation. Null when an idempotency index refused it
 * (already live / building for that version), or when a version it names is
 * not the row's org's (logged).
 */
export async function insertRemediation(row: PluginRemediationInsert): Promise<PluginRemediation | null> {
  const rows = await elevatedTx(async (tx) => {
    if (!await pluginsBelongToRowOrg(tx, row)) {
      logRefusedInsert(row);
      return [];
    }
    return tx.insert(R()).values(row).onConflictDoNothing().returning();
  }) as PluginRemediation[];
  return rows[0] ?? null;
}

/** Whether ANY remediation (whatever its stage) exists for this version and findings set. */
export async function remediationExistsFor(pluginId: string, findingsHash: string): Promise<boolean> {
  const rows = await elevatedTx((tx) => tx.select({ id: R().id }).from(R())
    .where(and(eq(R().pluginId, pluginId), eq(R().findingsHash, findingsHash))).limit(1)) as unknown[];
  return rows.length > 0;
}

/** Remediations created for `orgId` in the 24 h before `now` (the daily cap). */
export async function remediationsCreatedSince(orgId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await elevatedTx((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(R())
    .where(and(eq(R().orgId, orgId.toLowerCase()), gt(R().createdAt, since)))) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** The result of {@link insertRemediationUnderCap}. */
export type CappedInsert =
  | { status: 'inserted'; row: PluginRemediation }
  | { status: 'capped'; used: number }
  | { status: 'conflict' }
  /** A version the row names (`plugin_id`, `to_plugin_id`) is missing or another org's. Nothing was written. */
  | { status: 'refused' };

/**
 * Insert a remediation only while `orgId` is under its daily cap: the count of
 * the last 24 h and the insert run in ONE transaction under a per-org
 * transaction-scoped advisory lock, so concurrent retries (or a retry racing
 * the nightly pass) are serialized and can never exceed `cap` together.
 * `beforeInsert` runs inside the same transaction once the cap holds (retry
 * closes the needs_review row it replaces there). `conflict` = an idempotency
 * index refused the row (already live / building for that version);
 * `refused` = a version it names is not the row's org's (checked first).
 */
export async function insertRemediationUnderCap(
  row: PluginRemediationInsert,
  cap: number,
  opts: { now?: Date; beforeInsert?: (tx: any) => Promise<void> } = {}, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<CappedInsert> {
  const org = row.orgId.toLowerCase();
  const since = new Date((opts.now ?? new Date()).getTime() - 24 * 3_600_000);
  return elevatedTx(async (tx) => {
    if (!await pluginsBelongToRowOrg(tx, row)) {
      logRefusedInsert(row);
      return { status: 'refused' } as const;
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plugin-remediation-cap:${org}`}))`);
    const counted = await tx.select({ n: sql<number>`count(*)::int` }).from(R())
      .where(and(eq(R().orgId, org), gt(R().createdAt, since))) as Array<{ n: number }>;
    const used = Number(counted[0]?.n ?? 0);
    if (used >= cap) return { status: 'capped', used } as const;
    if (opts.beforeInsert) await opts.beforeInsert(tx);
    const rows = await tx.insert(R()).values({ ...row, orgId: org }).onConflictDoNothing().returning() as PluginRemediation[];
    return rows[0] ? { status: 'inserted', row: rows[0] } as const : { status: 'conflict' } as const;
  });
}

/**
 * Update a remediation, optionally only when it is still in one of `from`
 * stages (a guarded transition). Returns the new row, or null when the guard
 * did not hold. A patch that sets `toPluginId` also only applies while that
 * version is the row's own org's (in the same statement).
 */
export async function updateRemediation(
  id: string,
  patch: Partial<PluginRemediationInsert>,
  from?: readonly PluginRemediationStage[],
  opts: { undecided?: boolean } = {},
): Promise<PluginRemediation | null> {
  const rows = await elevatedTx((tx) => tx.update(R()).set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(R().id, id),
      ...(from ? [inArray(R().stage, [...from])] : []),
      // `undecided`: only while nobody has approved it yet (two approvals never both win).
      ...(opts.undecided ? [isNull(R().decidedAt)] : []),
      ...(patch.toPluginId ? [sql`EXISTS (SELECT 1 FROM ${P()} WHERE ${P().id} = ${patch.toPluginId} AND lower(${P().orgId}) = lower(${R().orgId}))`] : []),
    ))
    .returning()) as PluginRemediation[];
  return rows[0] ?? null;
}

/**
 * Read-modify-write one remediation under a row lock: `decide` sees the
 * current row and answers the patch to apply (null = none) plus a result. Two
 * concurrent callers (a redelivered report) serialize instead of both acting
 * on the same stale row. Null when the remediation does not exist.
 */
export async function lockedUpdateRemediation<T>(
  id: string,
  decide: (row: PluginRemediation) => { patch: Partial<PluginRemediationInsert> | null; result: T },
): Promise<{ before: PluginRemediation; row: PluginRemediation; result: T } | null> {
  if (!UUID.test(id)) return null;
  return elevatedTx(async (tx) => {
    const [before] = await tx.select().from(R()).where(eq(R().id, id)).limit(1).for('update') as PluginRemediation[];
    if (!before) return null;
    const { patch, result } = decide(before);
    if (!patch) return { before, row: before, result };
    const [row] = await tx.update(R()).set({ ...patch, updatedAt: new Date() }).where(eq(R().id, id)).returning() as PluginRemediation[];
    return { before, row: row ?? before, result };
  });
}

/** Every remediation still LIVE (the nightly supersede / deactivate sweep). */
export async function liveRemediations(limit = 5_000): Promise<PluginRemediation[]> {
  return await elevatedTx((tx) => tx.select().from(R()).where(inArray(R().stage, [...LIVE_REMEDIATION_STAGES])).limit(limit)) as PluginRemediation[];
}

/** Live remediations of these versions, or of a version they replace (`to_plugin_id`). */
export async function liveRemediationsTouching(orgId: string, pluginIds: readonly string[]): Promise<PluginRemediation[]> {
  if (pluginIds.length === 0) return [];
  return await elevatedTx((tx) => tx.select().from(R()).where(and(
    eq(R().orgId, orgId.toLowerCase()),
    inArray(R().stage, [...LIVE_REMEDIATION_STAGES]),
    or(inArray(R().pluginId, [...pluginIds]), inArray(R().toPluginId, [...pluginIds])),
  ))) as PluginRemediation[];
}

export interface ListQuery {
  orgId: string;
  stages?: PluginRemediationStage[];
  pluginId?: string;
  pluginName?: string;
  limit: number;
  cursor?: string;
}

const encodeCursor = (r: Pick<PluginRemediation, 'createdAt' | 'id'>): string => Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');
function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  const d = new Date(at ?? '');
  return Number.isNaN(d.getTime()) || !id || !UUID.test(id) ? null : { at: d, id };
}

/** One page of an org's remediations, newest first. */
export async function listRemediations(q: ListQuery): Promise<{ rows: PluginRemediation[]; nextCursor: string | null }> {
  const cur = decodeCursor(q.cursor);
  const rows = await elevatedTx((tx) => tx.select().from(R()).where(and(
    eq(R().orgId, q.orgId.toLowerCase()),
    ...(q.stages && q.stages.length > 0 ? [inArray(R().stage, q.stages)] : []),
    ...(q.pluginId ? [eq(R().pluginId, q.pluginId)] : []),
    ...(q.pluginName ? [eq(R().pluginName, q.pluginName)] : []),
    ...(cur ? [or(lt(R().createdAt, cur.at), and(eq(R().createdAt, cur.at), lt(R().id, cur.id)))!] : []),
  )).orderBy(desc(R().createdAt), desc(R().id)).limit(q.limit + 1)) as PluginRemediation[];
  const page = rows.slice(0, q.limit);
  return { rows: page, nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null };
}

/** Whether a version has a remediation still building or awaiting approval. */
export async function activeRemediationOf(pluginId: string): Promise<PluginRemediation | null> {
  const rows = await elevatedTx((tx) => tx.select().from(R()).where(and(eq(R().pluginId, pluginId), inArray(R().stage, [...ACTIVE_BUILD_REMEDIATION_STAGES]))).limit(1)) as PluginRemediation[];
  return rows[0] ?? null;
}

// -- settings -----------------------------------------------------------------------

export async function readSettingsRow(orgId: string): Promise<PluginRemediationSettingRow | null> {
  const rows = await elevatedTx((tx) => tx.select().from(S()).where(eq(S().orgId, orgId.toLowerCase())).limit(1)) as PluginRemediationSettingRow[];
  return rows[0] ?? null;
}

/** An org's effective settings. */
export async function readSettings(orgId: string, isTeam = false): Promise<PluginRemediationSettings> {
  return normalizePluginRemediationSettings(await readSettingsRow(orgId), { isTeam });
}

/** Upsert an org's settings row with `patch` (the caller has validated it). */
export async function writeSettings(orgId: string, patch: Partial<Omit<PluginRemediationSettingRow, 'orgId' | 'createdAt' | 'updatedAt'>>, by: string): Promise<PluginRemediationSettingRow> {
  const org = orgId.toLowerCase();
  const rows = await elevatedTx((tx) => tx.insert(S()).values({ orgId: org, ...patch, updatedBy: by })
    .onConflictDoUpdate({ target: S().orgId, set: { ...patch, updatedBy: by, updatedAt: new Date() } })
    .returning()) as PluginRemediationSettingRow[];
  return rows[0]!;
}

// -- plugin rows ------------------------------------------------------------------------

export async function pluginRow(id: string): Promise<Plugin | null> {
  if (!UUID.test(id)) return null;
  const rows = await elevatedTx((tx) => tx.select().from(P()).where(eq(P().id, id)).limit(1)) as Plugin[];
  return rows[0] ?? null;
}

/** Every version string of `name` in `orgId`, soft-deleted included (their numbers stay reserved). */
export async function takenVersions(orgId: string, name: string): Promise<string[]> {
  const rows = await elevatedTx((tx) => tx.select({ version: P().version }).from(P())
    .where(and(eq(P().orgId, orgId), eq(P().name, name)))) as Array<{ version: string }>;
  return rows.map((r) => r.version);
}

/**
 * The newest live, unflagged, unyanked version of an org plugin above `than`
 * that is NOT one of `exclude` (a remediation's own fix version) — the owner's
 * own clean upload, which supersedes a remediation.
 */
export async function newestCleanOwnerVersion(orgId: string, name: string, than: string, exclude: readonly string[] = []): Promise<string | null> {
  const rows = await elevatedTx((tx) => tx.select({ version: P().version, createdBy: P().createdBy }).from(P())
    .where(and(eq(P().orgId, orgId), eq(P().name, name), eq(P().isActive, true), isNull(P().deletedAt), isNull(P().yankedAt), isNull(P().scanFlaggedAt)))) as Array<{ version: string; createdBy: string | null }>;
  const above = rows.filter((r) => r.createdBy !== SYSTEM_PLUGIN_REMEDIATION && !exclude.includes(r.version) && compareSemverLenient(r.version, than) > 0).map((r) => r.version);
  return above.reduce<string | null>((best, v) => (best === null || compareSemverLenient(v, best) > 0 ? v : best), null);
}

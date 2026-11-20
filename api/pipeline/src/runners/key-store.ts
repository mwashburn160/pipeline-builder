// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence for the per-org runner signing keys, the key-mode rows and the
 * platform pause toggle.
 *
 * Every method runs ELEVATED (sysadmin tenant scope), like the runner store:
 * the sweep acts outside any user's org, and a team's signer reads its
 * ancestors' keys. Every state change goes through {@link RunnerKeyStore.transaction},
 * whose `lock*` reads take `SELECT … FOR UPDATE` on the org's rows, and every
 * UPDATE draws a fresh `runner_key_version` from the shared sequence (the
 * counter the replicas' signer caches poll).
 *
 * `private_key_enc` leaves this module only towards the signer (decrypt) and
 * the re-encrypt job. Nothing here logs a row.
 */

import type { RunnerKeyState } from '@pipeline-builder/api-core/pipeline-runners';
import {
  runWithTenantContext,
  schema,
  tableExists,
  withTenantTx,
  type PipelineRunnerKeySettingsInsert,
  type PipelineRunnerKeySettingsRow,
  type PipelineRunnerPlatformSettingsRow,
  type PipelineRunnerSigningKeyInsert,
  type PipelineRunnerSigningKeyRow,
} from '@pipeline-builder/pipeline-data';
import { and, eq, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';

export type KeyRow = PipelineRunnerSigningKeyRow;
export type KeyInsert = PipelineRunnerSigningKeyInsert;
export type KeySettingsRow = PipelineRunnerKeySettingsRow;
export type KeySettingsPatch = Partial<Omit<PipelineRunnerKeySettingsInsert, 'orgId' | 'runnerKeyVersion' | 'updatedAt'>>;
export type PauseRow = PipelineRunnerPlatformSettingsRow;

/** The writes one transaction may make. `lock*` reads hold the rows until COMMIT. */
export interface KeyTx {
  /** The org's non-retired keys, `FOR UPDATE`. */
  lockKeys(orgId: string): Promise<KeyRow[]>;
  /** One key row by id, `FOR UPDATE`. */
  lockKeyById(id: string): Promise<KeyRow | null>;
  /** The org's key-mode row (null when it has none), `FOR UPDATE`. */
  lockSettings(orgId: string): Promise<KeySettingsRow | null>;
  insertKey(row: KeyInsert): Promise<KeyRow>;
  /** Update one key; bumps its `runner_key_version`. */
  updateKey(id: string, patch: Partial<KeyInsert>): Promise<KeyRow>;
  /** Insert or update the org's key-mode row; bumps its `runner_key_version`. */
  upsertSettings(orgId: string, patch: KeySettingsPatch & { mode: KeySettingsRow['mode'] }): Promise<KeySettingsRow>;
}

export interface RunnerKeyStore {
  /** Whether this database has the key tables. */
  tablesPresent(): Promise<boolean>;
  /** Run `fn` in one transaction (rolled back when it throws). */
  transaction<T>(fn: (tx: KeyTx) => Promise<T>): Promise<T>;
  /** The non-retired keys of the given orgs (no lock). */
  publishedKeys(orgIds: readonly string[]): Promise<KeyRow[]>;
  /** The key-mode rows of the given orgs. */
  settings(orgIds: readonly string[]): Promise<KeySettingsRow[]>;
  /** The cache version of an org set: the greatest `runner_key_version` over its keys and key-mode rows (0 when none). */
  version(orgIds: readonly string[]): Promise<number>;
  /** Orgs holding a `next` key whose `activates_at` has passed. */
  orgsWithDueNext(now: Date): Promise<string[]>;
  /** Orgs holding a `retiring` key whose `retire_after` has passed. */
  orgsWithDueRetiring(now: Date): Promise<string[]>;
  /** Key-mode rows with a transition recorded. */
  transitions(): Promise<KeySettingsRow[]>;
  /** Every active key (age reminders and the age gauges). */
  activeKeys(): Promise<KeyRow[]>;
  /** Key rows per state across the deployment. */
  countByState(): Promise<Record<RunnerKeyState, number>>;
  /** The non-retired keys to re-encrypt (one org, or all), id/org/kid only. */
  encryptedKeyIds(orgId?: string): Promise<Array<Pick<KeyRow, 'id' | 'orgId' | 'kid'>>>;
  /** Pending + active runners per owning org. */
  runnerCounts(orgIds?: readonly string[]): Promise<Map<string, number>>;
  /** Every org with a key row or a key-mode row (the operator table). */
  keyOrgIds(): Promise<string[]>;
  /** The pause toggle (null = never set = not paused). */
  getPause(): Promise<PauseRow | null>;
  setPause(input: { paused: boolean; by: string | null; reason: string | null; at: Date }): Promise<PauseRow>;
}

const elevated = <T>(fn: Parameters<typeof withTenantTx<T>>[0]): Promise<T> =>
  runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));

const K = schema.pipelineRunnerSigningKey;
const S = schema.pipelineRunnerKeySettings;
const P = schema.pipelineRunnerPlatformSettings;
const R = schema.pipelineRunner;
const NEXT_VERSION = sql`nextval('pipeline_runner_key_version_seq')`;

type DrizzleTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

function keyTx(tx: DrizzleTx): KeyTx {
  return {
    lockKeyById: async (id) => (await tx.select().from(K).where(eq(K.id, id)).for('update'))[0] ?? null,
    lockKeys: (orgId) => tx.select().from(K).where(and(eq(K.orgId, orgId), ne(K.state, 'retired'))).for('update'),
    lockSettings: async (orgId) => (await tx.select().from(S).where(eq(S.orgId, orgId)).for('update'))[0] ?? null,
    insertKey: async (row) => (await tx.insert(K).values(row).returning())[0]!,
    updateKey: async (id, patch) => (await tx.update(K).set({ ...patch, runnerKeyVersion: NEXT_VERSION }).where(eq(K.id, id)).returning())[0]!,
    upsertSettings: async (orgId, patch) => (await tx.insert(S).values({ orgId, ...patch })
      .onConflictDoUpdate({ target: S.orgId, set: { ...patch, runnerKeyVersion: NEXT_VERSION } })
      .returning())[0]!,
  };
}

/** The Drizzle/Postgres implementation. */
export function createDrizzleKeyStore(): RunnerKeyStore {
  return {
    tablesPresent: () => runWithTenantContext({ isSuperAdmin: true }, async () =>
      (await tableExists('pipeline_runner_signing_keys'))
      && (await tableExists('pipeline_runner_key_settings'))
      && (await tableExists('pipeline_runner_platform_settings'))),
    transaction: (fn) => elevated((tx) => fn(keyTx(tx))),
    publishedKeys: (orgIds) => (orgIds.length === 0 ? Promise.resolve([]) : elevated((tx) => tx.select().from(K)
      .where(and(inArray(K.orgId, [...orgIds]), ne(K.state, 'retired'))))),
    settings: (orgIds) => (orgIds.length === 0 ? Promise.resolve([]) : elevated((tx) => tx.select().from(S).where(inArray(S.orgId, [...orgIds])))),
    version: (orgIds) => (orgIds.length === 0 ? Promise.resolve(0) : elevated(async (tx) => {
      const ids = [...orgIds];
      const [k] = await tx.select({ v: sql<string | null>`max(${K.runnerKeyVersion})` }).from(K).where(inArray(K.orgId, ids));
      const [s] = await tx.select({ v: sql<string | null>`max(${S.runnerKeyVersion})` }).from(S).where(inArray(S.orgId, ids));
      return Math.max(Number(k?.v ?? 0), Number(s?.v ?? 0));
    })),
    orgsWithDueNext: (now) => elevated(async (tx) => (await tx.selectDistinct({ orgId: K.orgId }).from(K)
      .where(and(eq(K.state, 'next'), lte(K.activatesAt, now)))).map((r) => r.orgId)),
    orgsWithDueRetiring: (now) => elevated(async (tx) => (await tx.selectDistinct({ orgId: K.orgId }).from(K)
      .where(and(eq(K.state, 'retiring'), lte(K.retireAfter, now)))).map((r) => r.orgId)),
    transitions: () => elevated((tx) => tx.select().from(S).where(isNotNull(S.transitionKind))),
    activeKeys: () => elevated((tx) => tx.select().from(K).where(eq(K.state, 'active'))),
    countByState: () => elevated(async (tx) => {
      const rows = await tx.select({ state: K.state, n: sql<number>`count(*)::int` }).from(K).groupBy(K.state);
      const out: Record<RunnerKeyState, number> = { next: 0, active: 0, retiring: 0, retired: 0 };
      for (const r of rows) out[r.state] = r.n;
      return out;
    }),
    encryptedKeyIds: (orgId) => elevated((tx) => tx.select({ id: K.id, orgId: K.orgId, kid: K.kid }).from(K)
      .where(and(ne(K.state, 'retired'), orgId ? eq(K.orgId, orgId) : undefined))),
    runnerCounts: (orgIds) => (orgIds && orgIds.length === 0 ? Promise.resolve(new Map()) : elevated(async (tx) => {
      const rows = await tx.select({ orgId: R.orgId, n: sql<number>`count(*)::int` }).from(R)
        .where(and(inArray(R.status, ['pending', 'active']), orgIds ? inArray(R.orgId, [...orgIds]) : undefined))
        .groupBy(R.orgId);
      return new Map(rows.map((r) => [r.orgId, r.n]));
    })),
    keyOrgIds: () => elevated(async (tx) => {
      const a = await tx.selectDistinct({ orgId: K.orgId }).from(K);
      const b = await tx.select({ orgId: S.orgId }).from(S);
      return [...new Set([...a, ...b].map((r) => r.orgId))];
    }),
    getPause: () => elevated(async (tx) => (await tx.select().from(P).where(eq(P.singleton, true)))[0] ?? null),
    setPause: ({ paused, by, reason, at }) => elevated(async (tx) => {
      const values = { deliveriesPaused: paused, pausedAt: paused ? at : null, pausedBy: paused ? by : null, pauseReason: paused ? reason : null };
      return (await tx.insert(P).values({ singleton: true, ...values })
        .onConflictDoUpdate({ target: P.singleton, set: values }).returning())[0]!;
    }),
  };
}

/** Postgres unique violation (a concurrent writer took the one-per-state slot). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

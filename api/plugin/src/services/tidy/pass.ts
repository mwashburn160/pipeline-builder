// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The daily automatic tidying job, and its dry run (docs/plugin-publishing.md
 * "Automatic tidying"). Per org (never the system org: its catalogue has the
 * superseded-version retention pass), under the org's `pluginRetention`:
 *
 *  1. WARN — a version within a week of going stale goes into the org's
 *     digest (N41, to the plugin security recipients): at most one a week,
 *     listing only versions not in an earlier one, with each version's dates
 *     and a Keep link. Nothing is sent to an org with nothing newly stale.
 *  2. DEACTIVATE (mode `on`) — on its deactivation date (N, never sooner than 7
 *     days after its warning): `is_active = false`. Nothing is deleted, and an
 *     exact pin still resolves it with a warning, so no pipeline breaks.
 *  3. RETIRE (mode `on`) — 30 days after deactivation, still unused and
 *     inactive: soft-deleted through the ordinary delete path, every version of
 *     the org's pass under ONE delete batch id, so Restore plugin brings them
 *     back for the soft-delete window.
 *  4. PURGE — the existing soft-delete purge sweep, 30 days later (N+60).
 *
 * Mode `notify` (the default) only warns. Every protection (facts.ts) is
 * re-read each day before anything is done; a version that became protected
 * while warned or deactivated has its warning dropped and is reactivated.
 *
 * Metrics (bounded labels): `plugin_tidy_versions_total{outcome}` (warned |
 * deactivated | retired | reactivated | kept), `plugin_tidy_skipped_total{reason}`
 * (decide.ts TIDY_SKIP_REASONS), `plugin_tidy_failed_total{stage}` (select |
 * notify | deactivate | retire | reactivate | use_stamp). Audits:
 * `plugin.tidy.warned` / `.deactivated` / `.retired` (system actor), `.kept`.
 */

import { randomUUID } from 'node:crypto';

import {
  AppError, createLogger, createScheduler, DEFAULT_LEADER_LOCK_TTL_MS, ErrorCode, errorMessage, leaderLockKey, recordAudit,
  SYSTEM_ACTOR_ID, SYSTEM_ORG_ID,
  type LockRedis, type QuotaService, type Scheduler,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { executeRows, runWithTenantContext, schema, type Plugin } from '@pipeline-builder/pipeline-data';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { DAY_MS, TIDY_DIGEST_INTERVAL_DAYS, tidyOperatorEnabled } from './config.js';
import { decideTidy, type TidyDecision, type TidySkipReason, type TidyState } from './decide.js';
import { orgVersionFacts, type TidyVersionFacts } from './facts.js';
import { readTidySettings, writeTidySettings, type AutoTidyMode, type TidySettings } from './settings.js';
import { clockRestartSet } from './usage.js';
import { autoRemovalProtection } from '../../helpers/auto-removal.js';
import { refundPluginSlot } from '../../helpers/quota-refund.js';
import { elevated } from '../ecosystem/store.js';
import { frontendBaseUrl } from '../ecosystem/submission-config.js';
import { enqueueEcosystemNotification } from '../ecosystem-notifications.js';
import { prefsStore, recipientsFor } from '../plugin-security-notifications.js';
import { pluginService } from '../plugin-service.js';
import { reclaimPlan } from '../storage-reclaim.js';

const logger = createLogger('plugin-tidy');

export const TIDY_VERSIONS_COUNTER = 'plugin_tidy_versions_total';
export const TIDY_SKIPPED_COUNTER = 'plugin_tidy_skipped_total';
export const TIDY_FAILED_COUNTER = 'plugin_tidy_failed_total';

/** Versions named in one digest's text (the rest are counted). */
const DIGEST_MAX_LINES = 100;

/** What the run did with one version (absent in a dry run). */
export type TidyAction = 'warned' | 'deactivated' | 'retired' | 'reactivated' | 'cleared' | 'refused' | 'failed';

/** One version in a tidy report (`fresh` versions are left out). */
export interface TidyVersionEntry {
  pluginId: string;
  name: string;
  version: string;
  state: TidyState;
  /** Why a protection holds it (`skipped`, `reactivate`, `clear`). */
  reason?: TidySkipReason;
  lastUsedAt: string | null;
  /** N: the day it goes (went) stale. */
  staleAt: string;
  warnedAt?: string;
  deactivateAt?: string;
  retireAt?: string;
  /** `warn_queued`: when the org's next digest may go out. */
  nextDigestAt?: string;
  /** Bytes its removal frees: its kept source plus, when measured, its image's marginal bytes. */
  bytes: number | null;
  /** The run's action. */
  action?: TidyAction;
  error?: string;
}

export interface TidyTotals {
  warn: number;
  warnQueued: number;
  warned: number;
  deactivate: number;
  deactivated: number;
  retire: number;
  skipped: number;
  reactivate: number;
  /** Bytes tidying frees once every stale version here is retired and purged; null when unmeasured. */
  bytesFreed: number | null;
}

/** One org's tidy report (the preview, or one org of a run). */
export interface TidyOrgReport {
  orgId: string;
  generatedAt: string;
  dryRun: boolean;
  /** `PLUGIN_AUTO_TIDY_ENABLED`: whether the daily job runs at all. */
  operatorEnabled: boolean;
  mode: AutoTidyMode;
  staleAfterDays: number;
  neverTidy: string[];
  lastDigestAt: string | null;
  nextDigestAt: string;
  versions: TidyVersionEntry[];
  totals: TidyTotals;
  /** Whether the image bytes are measured (the preview asks image-registry; a run does not). */
  storage: { measured: boolean };
  /** The delete batch the run's retirements share (run only, when any). */
  batchId?: string;
}

export interface TidyPassResult {
  generatedAt: string;
  dryRun: boolean;
  operatorEnabled: boolean;
  orgs: TidyOrgReport[];
}

const iso = (d: Date | null | undefined): string | undefined => (d ? d.toISOString() : undefined);
const DATE = (d: Date | undefined): string => (d ? d.toISOString().slice(0, 10) : 'unknown');
const TIDY_BOUND: ReadonlySet<TidyState> = new Set(['warn', 'warn_queued', 'warned', 'deactivate', 'deactivated', 'retire']);

/** The orgs with live plugin versions (never the system org). */
async function tidyOrgIds(): Promise<string[]> {
  const rows = await elevated((tx) => executeRows<{ org_id: string }>(tx, sql`
    SELECT DISTINCT lower(org_id) AS org_id FROM plugins WHERE deleted_at IS NULL AND lower(org_id) <> ${SYSTEM_ORG_ID.toLowerCase()} ORDER BY 1`));
  return rows.map((r) => r.org_id);
}

/** Image marginal bytes per `name@version`, or null when image-registry cannot answer. */
async function imageBytes(orgId: string): Promise<Map<string, number> | null> {
  try {
    const plan = await reclaimPlan(orgId);
    if (!plan) return null;
    return new Map(plan.candidates.filter((c) => c.pluginName && c.version).map((c) => [`${c.pluginName}@${c.version}`, c.marginalBytes]));
  } catch {
    return null;
  }
}

function emptyTotals(measured: boolean): TidyTotals {
  return { warn: 0, warnQueued: 0, warned: 0, deactivate: 0, deactivated: 0, retire: 0, skipped: 0, reactivate: 0, bytesFreed: measured ? 0 : null };
}

const TOTAL_KEY: Partial<Record<TidyState, keyof Omit<TidyTotals, 'bytesFreed'>>> = {
  warn: 'warn', warn_queued: 'warnQueued', warned: 'warned', deactivate: 'deactivate', deactivated: 'deactivated', retire: 'retire', skipped: 'skipped', reactivate: 'reactivate',
};

interface Planned { facts: TidyVersionFacts; decision: TidyDecision; entry: TidyVersionEntry }

/** Decide every version of one org (no writes). */
async function planOrg(orgId: string, settings: TidySettings, now: Date, bytes: Map<string, number> | null): Promise<{ planned: Planned[]; nextDigestAt: Date }> {
  const last = settings.lastDigestAt ? new Date(settings.lastDigestAt) : null;
  const nextDigestAt = last ? new Date(last.getTime() + TIDY_DIGEST_INTERVAL_DAYS * DAY_MS) : now;
  if (settings.autoTidy === 'off') return { planned: [], nextDigestAt };
  const mode = settings.autoTidy;
  const facts = await orgVersionFacts(orgId, settings, now);
  const planned: Planned[] = [];
  for (const f of facts) {
    // The owner turned a tidy-deactivated version back on by hand: drop the tidy state.
    const decision: TidyDecision = f.row.isActive && f.clock.deactivatedAt
      ? { state: 'reactivate', staleAt: new Date(0) }
      : decideTidy({ clock: f.clock, protection: f.protection, mode, staleAfterDays: settings.staleAfterDays, now, nextDigestAt });
    if (decision.state === 'fresh') continue;
    const source = f.row.sourceKind === 'zip' ? Number(f.row.sourceSizeBytes ?? 0) : 0;
    const image = bytes ? bytes.get(`${f.row.name}@${f.row.version}`) ?? 0 : 0;
    planned.push({
      facts: f,
      decision,
      entry: {
        pluginId: f.row.id,
        name: f.row.name,
        version: f.row.version,
        state: decision.state,
        ...(decision.reason ? { reason: decision.reason } : {}),
        lastUsedAt: iso(f.clock.lastUsedAt) ?? null,
        staleAt: decision.staleAt.toISOString(),
        ...(f.clock.warnedAt ? { warnedAt: f.clock.warnedAt.toISOString() } : {}),
        ...(decision.deactivateAt ? { deactivateAt: decision.deactivateAt.toISOString() } : {}),
        ...(decision.retireAt ? { retireAt: decision.retireAt.toISOString() } : {}),
        ...(decision.state === 'warn_queued' ? { nextDigestAt: nextDigestAt.toISOString() } : {}),
        bytes: source + image,
      },
    });
  }
  return { planned, nextDigestAt };
}

function buildReport(orgId: string, settings: TidySettings, now: Date, dryRun: boolean, planned: readonly Planned[], nextDigestAt: Date, measured: boolean): TidyOrgReport {
  const totals = emptyTotals(measured);
  for (const { entry } of planned) {
    const key = TOTAL_KEY[entry.state];
    if (key) totals[key]++;
    if (TIDY_BOUND.has(entry.state) && totals.bytesFreed !== null) totals.bytesFreed += entry.bytes ?? 0;
  }
  return {
    orgId,
    generatedAt: now.toISOString(),
    dryRun,
    operatorEnabled: tidyOperatorEnabled(),
    mode: settings.autoTidy,
    staleAfterDays: settings.staleAfterDays,
    neverTidy: settings.neverTidy,
    lastDigestAt: settings.lastDigestAt,
    nextDigestAt: nextDigestAt.toISOString(),
    versions: planned.map((p) => p.entry),
    totals,
    storage: { measured },
  };
}

/** The keep link a digest gives each version. */
export const keepUrl = (pluginId: string): string => `${frontendBaseUrl()}/dashboard/plugins?tidyKeep=${encodeURIComponent(pluginId)}`;

/** The digest one org gets (N41). */
export function renderDigest(settings: TidySettings, entries: readonly TidyVersionEntry[]): { subject: string; text: string } {
  const n = entries.length;
  const on = settings.autoTidy === 'on';
  const lines = entries.slice(0, DIGEST_MAX_LINES).map((e) => {
    const used = e.lastUsedAt ? `last used ${DATE(new Date(e.lastUsedAt))}` : 'never used';
    const when = on
      ? `deactivated on ${DATE(e.deactivateAt ? new Date(e.deactivateAt) : undefined)}, deleted 30 days later if still unused`
      : `would be deactivated on ${DATE(e.deactivateAt ? new Date(e.deactivateAt) : undefined)} if automatic tidying were on`;
    return `  • ${e.name}@${e.version} — ${used}, stale since ${DATE(new Date(e.staleAt))}; ${when}. Keep: ${keepUrl(e.pluginId)}`;
  });
  const more = n > DIGEST_MAX_LINES ? `\n  … and ${n - DIGEST_MAX_LINES} more (see Settings → Organization → Plugin security → Automatic tidying).` : '';
  const what = on
    ? 'Automatic tidying deactivates each on the date shown — an exact pin keeps resolving it, with a warning, so no pipeline breaks — and soft-deletes it 30 days later if it is still unused. A deleted version can be restored for 30 days.'
    : 'Automatic tidying is set to notify, so nothing will change; this is a list of versions you could delete.';
  return {
    subject: `${n} unused plugin version${n === 1 ? ' is' : 's are'} stale`,
    text: [
      `These plugin versions in your organization have not been used by a pipeline for ${settings.staleAfterDays} days. ${what}`,
      lines.join('\n') + more,
      'Keep a version to restart its clock, or set a plugin to never tidy on its page. Using a version again (a synth or a pipeline save resolving it) restarts its clock too. Change the mode or the number of days in Settings → Organization → Plugin security.',
    ].join('\n\n').slice(0, 10_000),
  };
}

function audit(action: 'plugin.tidy.warned' | 'plugin.tidy.deactivated' | 'plugin.tidy.retired' | 'plugin.tidy.kept', orgId: string, row: Plugin, details: Record<string, unknown> = {}): void {
  recordAudit({
    action,
    actorId: SYSTEM_ACTOR_ID,
    orgId,
    targetType: 'plugin',
    targetId: row.id,
    details: { pluginName: row.name, version: row.version, ...details },
  });
}

/** Act on one org's plan. Never throws for one version; counts each failure. */
async function actOnOrg(orgId: string, settings: TidySettings, now: Date, planned: Planned[], quotaService?: QuotaService): Promise<string | undefined> {
  const set = (p: Planned, action: TidyAction, error?: string) => { p.entry.action = action; if (error) p.entry.error = error; };
  const P = schema.plugin;

  for (const p of planned) {
    if (p.decision.state === 'skipped') incCounter(TIDY_SKIPPED_COUNTER, { reason: p.decision.reason ?? 'in_use' });
  }

  // Reactivate / clear: a protection now holds it, or its clock restarted.
  for (const p of planned.filter((x) => x.decision.state === 'reactivate' || x.decision.state === 'clear')) {
    try {
      const rows = await elevated((tx) => tx.update(P).set(clockRestartSet()).where(and(eq(P.id, p.facts.row.id), isNull(P.deletedAt))).returning()) as Plugin[];
      if (p.decision.state === 'reactivate') {
        await pluginService.afterManagedWrite(rows, SYSTEM_ACTOR_ID);
        incCounter(TIDY_VERSIONS_COUNTER, { outcome: 'reactivated' });
        audit('plugin.tidy.kept', orgId, p.facts.row, { scope: 'version', trigger: p.decision.reason ? 'protected' : 'clock_restarted', ...(p.decision.reason ? { reason: p.decision.reason } : {}) });
        set(p, 'reactivated');
      } else {
        set(p, 'cleared');
      }
    } catch (err) {
      incCounter(TIDY_FAILED_COUNTER, { stage: 'reactivate' });
      set(p, 'failed', errorMessage(err));
    }
  }

  // Warn: ONE digest for the org's newly stale versions; marked warned only once it is queued.
  const warn = planned.filter((x) => x.decision.state === 'warn');
  if (warn.length > 0) {
    let notified = false;
    try {
      const prefs = await prefsStore.get(orgId);
      await enqueueEcosystemNotification('N41', await recipientsFor(prefs), renderDigest(settings, warn.map((w) => w.entry)), { immediate: true });
      notified = true;
    } catch (err) {
      incCounter(TIDY_FAILED_COUNTER, { stage: 'notify' });
      logger.warn('Tidy digest not sent; the versions are warned in a later pass', { orgId, error: errorMessage(err) });
      for (const p of warn) set(p, 'failed', 'digest not sent');
    }
    if (notified) {
      await writeTidySettings(orgId, { lastDigestAt: now }, SYSTEM_ACTOR_ID);
      for (const p of warn) {
        await elevated((tx) => tx.update(P).set({ tidyWarnedAt: now, tidyDeactivateAfter: p.decision.deactivateAt ?? now }).where(eq(P.id, p.facts.row.id)));
        p.entry.warnedAt = now.toISOString();
        incCounter(TIDY_VERSIONS_COUNTER, { outcome: 'warned' });
        audit('plugin.tidy.warned', orgId, p.facts.row, { mode: settings.autoTidy, staleAt: p.entry.staleAt, deactivateAt: p.entry.deactivateAt });
        set(p, 'warned');
      }
    }
  }

  // Deactivate (on mode): nothing deleted; an exact pin still resolves it.
  for (const p of planned.filter((x) => x.decision.state === 'deactivate')) {
    try {
      const rows = await elevated((tx) => tx.update(P)
        .set({ isActive: false, tidyDeactivatedAt: now, updatedBy: SYSTEM_ACTOR_ID })
        .where(and(eq(P.id, p.facts.row.id), eq(P.isActive, true), isNull(P.tidyDeactivatedAt), isNull(P.deletedAt)))
        .returning()) as Plugin[];
      if (rows.length === 0) { set(p, 'refused', 'changed since it was read'); continue; }
      await pluginService.afterManagedWrite(rows, SYSTEM_ACTOR_ID);
      incCounter(TIDY_VERSIONS_COUNTER, { outcome: 'deactivated' });
      audit('plugin.tidy.deactivated', orgId, p.facts.row, { staleAt: p.entry.staleAt, retireAt: p.entry.retireAt });
      set(p, 'deactivated');
    } catch (err) {
      incCounter(TIDY_FAILED_COUNTER, { stage: 'deactivate' });
      set(p, 'failed', errorMessage(err));
    }
  }

  // Retire (on mode): the ordinary soft-delete, one batch id for the org's pass.
  const retire = planned.filter((x) => x.decision.state === 'retire');
  if (retire.length === 0) return undefined;
  const batchId = randomUUID();
  let retired = 0;
  for (const p of retire) {
    const row = p.facts.row;
    const others = await elevated((tx) => executeRows<{ n: number | string }>(tx, sql`
      SELECT count(*)::int AS n FROM plugins WHERE org_id = ${row.orgId} AND name = ${row.name} AND id <> ${row.id}::uuid AND deleted_at IS NULL`));
    const protection = autoRemovalProtection({ isActive: row.isActive, deletedAt: row.deletedAt, otherLiveVersions: Number(others[0]?.n ?? 0) });
    if (protection) { set(p, 'refused', protection); continue; }
    try {
      const { deleted } = await pluginService.deleteVersion(row, orgId, SYSTEM_ACTOR_ID, { force: p.facts.listed });
      if (!deleted) { set(p, 'refused', 'not found'); continue; }
      await elevated((tx) => tx.update(P).set({ deleteBatchId: batchId }).where(eq(P.id, row.id)));
      if (quotaService) refundPluginSlot(quotaService, row, (m, d) => logger.warn(m, d as Record<string, unknown>));
      retired++;
      incCounter(TIDY_VERSIONS_COUNTER, { outcome: 'retired' });
      audit('plugin.tidy.retired', orgId, row, { batchId, deactivatedAt: iso(p.facts.clock.deactivatedAt), bytes: p.entry.bytes });
      set(p, 'retired');
    } catch (err) {
      if (err instanceof AppError && (err.code === ErrorCode.PLUGIN_VERSION_IN_USE || err.code === ErrorCode.PLUGIN_VERSION_FROZEN)) {
        set(p, 'refused', err.code);
        continue;
      }
      incCounter(TIDY_FAILED_COUNTER, { stage: 'retire' });
      set(p, 'failed', errorMessage(err));
    }
  }
  return retired > 0 ? batchId : undefined;
}

/** One org: plan, and (unless a dry run) act. */
async function tidyOrg(orgId: string, now: Date, opts: { dryRun: boolean; measure: boolean; quotaService?: QuotaService }): Promise<TidyOrgReport> {
  const org = orgId.toLowerCase();
  return runWithTenantContext({ orgId: org, isSuperAdmin: true }, async () => {
    const settings = await readTidySettings(org);
    const bytes = opts.measure && settings.autoTidy !== 'off' ? await imageBytes(org) : null;
    const { planned, nextDigestAt } = await planOrg(org, settings, now, bytes);
    const batchId = opts.dryRun ? undefined : await actOnOrg(org, settings, now, planned, opts.quotaService);
    const report = buildReport(org, settings, now, opts.dryRun, planned, nextDigestAt, bytes !== null);
    return batchId ? { ...report, batchId } : report;
  });
}

/** The preview: one org's dry run, with the bytes tidying would free. Works whatever the operator switch says. */
export async function tidyPreview(orgId: string, opts: { now?: Date } = {}): Promise<TidyOrgReport> {
  return tidyOrg(orgId, opts.now ?? new Date(), { dryRun: true, measure: true });
}

/**
 * One pass over every org. With the operator switch off, a real pass does
 * nothing at all (and says so); a dry run still plans.
 */
export async function runTidyPass(opts: { dryRun: boolean; now?: Date; orgIds?: string[]; quotaService?: QuotaService; signal?: AbortSignal }): Promise<TidyPassResult> {
  const now = opts.now ?? new Date();
  const operatorEnabled = tidyOperatorEnabled();
  const result: TidyPassResult = { generatedAt: now.toISOString(), dryRun: opts.dryRun, operatorEnabled, orgs: [] };
  if (!opts.dryRun && !operatorEnabled) return result;
  let orgIds: string[];
  try {
    orgIds = opts.orgIds ?? await tidyOrgIds();
  } catch (err) {
    incCounter(TIDY_FAILED_COUNTER, { stage: 'select' });
    throw err;
  }
  for (const orgId of orgIds) {
    if (opts.signal?.aborted) break;
    try {
      result.orgs.push(await tidyOrg(orgId, now, { dryRun: opts.dryRun, measure: false, quotaService: opts.quotaService }));
    } catch (err) {
      incCounter(TIDY_FAILED_COUNTER, { stage: 'select' });
      logger.warn('Tidy pass skipped an org', { orgId, error: errorMessage(err) });
    }
  }
  if (!opts.dryRun) {
    const totals = result.orgs.reduce((acc, o) => ({ warned: acc.warned + o.versions.filter((v) => v.action === 'warned').length, deactivated: acc.deactivated + o.versions.filter((v) => v.action === 'deactivated').length, retired: acc.retired + o.versions.filter((v) => v.action === 'retired').length }), { warned: 0, deactivated: 0, retired: 0 });
    logger.info('Plugin tidy pass finished', { orgs: result.orgs.length, ...totals });
  }
  return result;
}

/** The daily job: leader-locked on the shared Redis (one replica per day). */
export function createTidyScheduler(redis: () => LockRedis, quotaService?: QuotaService): Scheduler {
  return createScheduler({
    name: 'plugin-auto-tidy',
    intervalMs: 24 * 60 * 60_000,
    startupDelayMs: 7 * 60_000,
    lock: { redis, key: leaderLockKey('plugin', 'auto-tidy'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
    run: async (lease?: { signal?: AbortSignal }) => {
      if (!tidyOperatorEnabled()) return;
      await runTidyPass({ dryRun: false, signal: lease?.signal, ...(quotaService ? { quotaService } : {}) });
    },
  });
}

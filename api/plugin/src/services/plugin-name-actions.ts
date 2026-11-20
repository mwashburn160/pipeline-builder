// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whole-plugin actions: delete every version of a name, and restore or purge
 * the batch such a delete soft-deleted (routes/plugin-by-name.ts).
 *
 * Delete plugin:
 * - a managed toolchain name is refused before anything is touched;
 * - runs under the name lock (helpers/plugin-name-lock.ts), after cancelling the
 *   name's queued builds and remediations, cancelling its remediation records
 *   (`cancelRemediationsFor`, which also stops their rollouts) and waiting for
 *   running builds (queue/name-inflight.ts);
 * - soft-deletes each version it can through the ordinary single-version path
 *   (`deleteVersion`: frozen, in-use and — without force — listed versions are
 *   refused there too), non-default versions first so no deleted version is
 *   promoted to default on the way; every deleted version gets the same
 *   `delete_batch_id`;
 * - answers deleted and skipped lists, each skip with its reason and (in use)
 *   the org's pipelines on it;
 * - refunds each version's `plugins` slot, audits `plugin.delete` per version
 *   and one `plugin.delete-all` naming all of them under the batch id, and
 *   sends ONE N14 notice per org that used any of the versions.
 *
 * Only the caller's own org's rows are ever read or written: a team that sees a
 * name through its root org has nothing to delete (`inheritedFromRoot`).
 *
 * Restore plugin / Purge plugin act on ONE batch only — never on versions
 * deleted earlier on their own. A restore re-charges a `plugins` slot per
 * version (like the single restore; a version over the cap is skipped). A purge
 * removes, per version, the row (and with it its `plugin_remediations` rows,
 * FK cascade), then its kept-source prefix and its image
 * (services/version-purge.ts).
 */

import { randomUUID } from 'node:crypto';

import {
  actorId, AppError, ErrorCode, getStatusForErrorCode, isManagedToolchainPlugin, PLUGIN_DELETE_INFLIGHT_WAIT_MS, recordAudit, SYSTEM_ACTOR_ID,
  type PluginBatchActionResult, type PluginDeleteAllResult, type PluginDeletePreview, type PluginDeleteSkip,
  type PluginDeleteSkipReason, type QuotaService, type VisibilityWriteVerdict,
} from '@pipeline-builder/api-core';
import { withQuotaReservation } from '@pipeline-builder/api-server';
import { distinctPipelines, runWithTenantContext, schema, withTenantTx, type Plugin } from '@pipeline-builder/pipeline-data';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { listingsWithPublishers, versions as ecosystemVersions } from './ecosystem/store.js';
import { pluginService } from './plugin-service.js';
import { cancelRemediationsFor } from './remediation/cancel.js';
import { notifyWithdrawal } from './version-withdrawal.js';
import { withPluginNameLock } from '../helpers/plugin-name-lock.js';
import { refundPluginSlot } from '../helpers/quota-refund.js';
import { cancelQueued, countInFlight, waitForRunning } from '../queue/name-inflight.js';

/** Who is acting, and how their per-row visibility rights are checked. */
export interface NameActionCaller {
  orgId: string;
  userId: string;
  /** The team's root org, when the caller's org is a team. */
  parentOrgId: string | null;
  /** The visibility ladder for one row (`checkVisibilityWriteAccess` bound to the request). */
  checkWrite: (row: Plugin) => VisibilityWriteVerdict;
  logWarn: (message: string, data?: unknown) => void;
}

/** Pipelines an in-use skip names (the contract's cap). */
const MAX_SKIP_PIPELINES = 50;

const p = schema.plugin;

/** The org's own LIVE rows of `name`: non-defaults first, then newest first. */
async function liveRows(orgId: string, name: string): Promise<Plugin[]> {
  const rows = await withTenantTx((tx) => tx.select().from(p)
    .where(and(eq(p.orgId, orgId), eq(p.name, name), isNull(p.deletedAt)))
    .orderBy(p.isDefault, desc(p.createdAt))) as Plugin[];
  return rows;
}

/** The org's tombstones of `name` in one delete batch. */
async function batchRows(orgId: string, name: string, batchId: string): Promise<Plugin[]> {
  return withTenantTx((tx) => tx.select().from(p)
    .where(and(eq(p.orgId, orgId), eq(p.name, name), eq(p.deleteBatchId, batchId), isNotNull(p.deletedAt)))
    .orderBy(desc(p.createdAt))) as Promise<Plugin[]>;
}

/** Whether the team's root org has a live version of `name` (elevated: RLS hides the root's rows from a team). */
async function rootHasName(parentOrgId: string | null, name: string): Promise<boolean> {
  if (!parentOrgId) return false;
  const rows = await runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx.select({ id: p.id }).from(p)
    .where(and(eq(p.orgId, parentOrgId.toLowerCase()), eq(p.name, name), isNull(p.deletedAt))).limit(1)));
  return rows.length > 0;
}

/** Why `row` can't be deleted (with the org's pipelines on it, when in use), or null. */
async function skipFor(row: Plugin, orgId: string, force: boolean): Promise<PluginDeleteSkip | null> {
  const blockers = await pluginService.deleteBlockers(row, orgId);
  if (blockers.frozen) return { id: row.id, version: row.version, reason: 'frozen' };
  if (blockers.inUse > 0) {
    const pipelines = distinctPipelines(await pluginService.versionReferences(row))
      .filter((x) => x.orgId.toLowerCase() === orgId)
      .slice(0, MAX_SKIP_PIPELINES)
      .map((x) => ({ id: x.pipelineId, name: x.pipelineName }));
    return { id: row.id, version: row.version, reason: 'in_use', pipelines };
  }
  if (blockers.listed && !force) return { id: row.id, version: row.version, reason: 'listed' };
  return null;
}

/** The listing published from any of `rows`, for the dialog's "unmaintained / yank" offer. */
async function listingOf(rows: readonly Plugin[]): Promise<PluginDeletePreview['listing']> {
  if (rows.length === 0) return null;
  const listed = await ecosystemVersions.bySourcePlugins(rows.map((r) => r.id));
  if (listed.length === 0) return null;
  const owners = await listingsWithPublishers(listed.map((v) => v.listingId));
  for (const v of listed) {
    const o = owners.get(v.listingId);
    if (o?.listing && o.publisher) return { id: o.listing.id, publisher: o.publisher.handle };
  }
  return null;
}

/** Live remediation records on any of these versions (own org). */
async function liveRemediationCount(pluginIds: readonly string[]): Promise<number> {
  if (pluginIds.length === 0) return 0;
  const r = schema.pluginRemediation;
  const [row] = await withTenantTx((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(r)
    .where(and(inArray(r.pluginId, [...pluginIds]), sql`${r.stage} NOT IN ('done', 'needs_owner', 'failed')`)));
  return Number(row?.n ?? 0);
}

/** What a delete of `name` would delete and skip, and why. The dialog and scripts read the same answer. */
export async function previewDeleteByName(name: string, caller: NameActionCaller, opts: { force: boolean }): Promise<PluginDeletePreview> {
  const rows = await liveRows(caller.orgId, name);
  const inheritedFromRoot = rows.length === 0 && await rootHasName(caller.parentOrgId, name);
  const deletable: PluginDeletePreview['deletable'] = [];
  const skipped: PluginDeleteSkip[] = [];
  for (const row of rows) {
    const skip = await skipFor(row, caller.orgId, opts.force);
    if (skip) skipped.push(skip);
    else deletable.push({ id: row.id, version: row.version, sourceBytes: row.sourceKind === 'zip' ? Number(row.sourceSizeBytes ?? 0) : null });
  }
  const queued = await countInFlight(caller.orgId, name);
  return {
    name,
    inheritedFromRoot,
    listing: await listingOf(rows),
    deletable,
    skipped,
    inFlight: { builds: queued.builds, remediations: Math.max(queued.remediations, await liveRemediationCount(rows.map((r) => r.id))) },
  };
}

/**
 * A managed toolchain name is never deleted, restored or purged as a whole
 * plugin: `PLUGIN_MANAGED_NAME_RESERVED`, at the status api-core's catalog maps
 * it to — before any version is touched.
 */
function assertNameNotManaged(name: string): void {
  if (!isManagedToolchainPlugin(name)) return;
  throw new AppError(getStatusForErrorCode(ErrorCode.PLUGIN_MANAGED_NAME_RESERVED), ErrorCode.PLUGIN_MANAGED_NAME_RESERVED,
    `"${name}" is a managed toolchain plugin; its releases are managed in the Toolchain console.`, { name });
}

/** 404 for a name the org has no live version of (a team's inherited name included). */
function nameNotFound(name: string, inheritedFromRoot: boolean): AppError {
  return new AppError(404, ErrorCode.NOT_FOUND, inheritedFromRoot
    ? `Plugin "${name}" comes from your root organization; a team has no versions of it to delete.`
    : `Plugin "${name}" has no versions in your organization.`, { name, inheritedFromRoot });
}

/** 403 before anything is touched: a version the caller may not delete (private to another author, or public without plugins:publish). */
function visibilityRefusal(name: string, refused: ReadonlyArray<{ id: string; version: string; verdict: VisibilityWriteVerdict }>): AppError {
  return new AppError(403, ErrorCode.INSUFFICIENT_PERMISSIONS,
    `You may not delete ${refused.length} version${refused.length === 1 ? '' : 's'} of "${name}" (${refused.map((r) => r.version).join(', ')}); nothing was deleted.`,
    { versions: refused.map((r) => ({ id: r.id, version: r.version, reason: r.verdict })) });
}

/** The skip reason a refusal of `deleteVersion` stands for (a race since the plan). */
function refusalReason(err: unknown): PluginDeleteSkipReason | null {
  if (!(err instanceof AppError)) return null;
  if (err.code === ErrorCode.PLUGIN_VERSION_FROZEN) return 'frozen';
  if (err.code === ErrorCode.PLUGIN_VERSION_IN_USE) return (err.details?.reason === 'listed' ? 'listed' : 'in_use');
  return null;
}

/** Delete every version of `name` the caller can (see the module comment). */
export async function deleteByName(name: string, caller: NameActionCaller, opts: { force: boolean; quotaService: QuotaService }): Promise<PluginDeleteAllResult & { cancelled: { builds: number; remediations: number } }> {
  assertNameNotManaged(name);
  const { orgId, userId } = caller;
  return withPluginNameLock(orgId, name, async () => {
    const before = await liveRows(orgId, name);
    if (before.length === 0) throw nameNotFound(name, await rootHasName(caller.parentOrgId, name));
    const refused = before.map((row) => ({ id: row.id, version: row.version, verdict: caller.checkWrite(row) })).filter((r) => r.verdict !== 'ok');
    if (refused.length > 0) throw visibilityRefusal(name, refused);

    // Nothing new lands from here: queued work goes, running work finishes
    // (or is refused at its store), remediations stop.
    const cancelledJobs = await cancelQueued(orgId, name, opts.quotaService);
    let cancelledRemediations = 0;
    try {
      cancelledRemediations = await cancelRemediationsFor({ orgId, pluginIds: before.map((r) => r.id), reason: 'name_deleted' });
    } catch (err) {
      caller.logWarn('Remediations of a deleted plugin were not all cancelled', { name, error: String(err) });
    }
    await waitForRunning(orgId, name, PLUGIN_DELETE_INFLIGHT_WAIT_MS);

    const batchId = randomUUID();
    const deleted: Plugin[] = [];
    const skipped: PluginDeleteSkip[] = [];
    for (const row of await liveRows(orgId, name)) {
      const skip = await skipFor(row, orgId, opts.force);
      if (skip) {
        skipped.push(skip);
        continue;
      }
      let gone: Plugin | null;
      try {
        ({ deleted: gone } = await pluginService.deleteVersion(row, orgId, userId || SYSTEM_ACTOR_ID, { force: opts.force }));
      } catch (err) {
        const reason = refusalReason(err);
        if (!reason) throw err;
        skipped.push({ id: row.id, version: row.version, reason });
        continue;
      }
      if (!gone) continue;
      await withTenantTx((tx) => tx.update(p).set({ deleteBatchId: batchId }).where(eq(p.id, row.id)));
      refundPluginSlot(opts.quotaService, row, caller.logWarn);
      deleted.push(row);
      recordAudit({
        action: 'plugin.delete',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'plugin',
        targetId: row.id,
        details: { pluginName: row.name, version: row.version, visibility: row.visibility, batchId, ...(opts.force ? { force: true } : {}) },
      });
    }

    recordAudit({
      action: 'plugin.delete-all',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: name,
      details: {
        pluginName: name,
        batchId,
        done: deleted.map((r) => ({ id: r.id, version: r.version })),
        skipped: skipped.map((s) => ({ id: s.id, version: s.version, reason: s.reason })),
        ...(opts.force ? { force: true } : {}),
        cancelledBuilds: cancelledJobs.builds,
        cancelledRemediations: Math.max(cancelledJobs.remediations, cancelledRemediations),
      },
    });

    // One N14 per org that used ANY of the deleted versions.
    if (deleted.length > 0) {
      const orgs = new Set<string>();
      for (const row of deleted) {
        try {
          for (const o of await pluginService.findOrgsUsingVersion(row)) orgs.add(o.toLowerCase());
        } catch (err) {
          caller.logWarn('Orgs using a deleted version not read; they get no notice', { id: row.id, error: String(err) });
        }
      }
      if (orgs.size > 0) {
        void notifyWithdrawal({ label: `${name} (${deleted.length} version${deleted.length === 1 ? '' : 's'})`, kind: 'deleted', affected: [], orgIds: [...orgs] });
      }
    }

    return {
      batchId,
      deleted: deleted.map((r) => ({ id: r.id, version: r.version })),
      skipped,
      cancelled: { builds: cancelledJobs.builds, remediations: Math.max(cancelledJobs.remediations, cancelledRemediations) },
    };
  });
}

/** Restore the versions batch `batchId` soft-deleted (see the module comment). */
export async function restoreByName(name: string, batchId: string, caller: NameActionCaller, opts: { quotaService: QuotaService }): Promise<PluginBatchActionResult> {
  assertNameNotManaged(name);
  const { orgId, userId } = caller;
  return withPluginNameLock(orgId, name, async () => {
    const rows = await batchRows(orgId, name, batchId);
    if (rows.length === 0) throw new AppError(404, ErrorCode.NOT_FOUND, `No deleted versions of "${name}" in batch ${batchId}.`, { name, batchId });
    const done: PluginBatchActionResult['done'] = [];
    const skipped: PluginBatchActionResult['skipped'] = [];
    for (const row of rows) {
      const verdict = caller.checkWrite(row);
      if (verdict !== 'ok') {
        skipped.push({ id: row.id, version: row.version, reason: verdict });
        continue;
      }
      const outcome = await withQuotaReservation(
        { quotaService: opts.quotaService, orgId, type: 'plugins', serviceName: 'plugin', logWarn: caller.logWarn },
        async (slot) => {
          const restored = await pluginService.restore(row.id, orgId, userId || SYSTEM_ACTOR_ID);
          if (!restored) {
            slot.refund();
            return null;
          }
          slot.markConsumed();
          await withTenantTx((tx) => tx.update(p).set({ deleteBatchId: null }).where(eq(p.id, row.id)));
          await pluginService.setQuotaSnapshot(row.id, slot.reservation.quota.resetAt ?? null);
          return restored;
        },
      );
      if (outcome.status !== 'done') {
        skipped.push({ id: row.id, version: row.version, reason: 'quota_exceeded' });
        continue;
      }
      if (!outcome.value) {
        skipped.push({ id: row.id, version: row.version, reason: 'not_restorable' });
        continue;
      }
      done.push({ id: row.id, version: row.version });
      recordAudit({
        action: 'plugin.restore',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'plugin',
        targetId: row.id,
        details: { pluginName: row.name, version: row.version, visibility: row.visibility, batchId },
      });
    }
    recordAudit({
      action: 'plugin.restore-all',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: name,
      details: { pluginName: name, batchId, done, skipped },
    });
    return { batchId, done, skipped };
  });
}

/** Purge the versions batch `batchId` soft-deleted (see the module comment). */
export async function purgeByName(name: string, batchId: string, caller: NameActionCaller, opts: { quotaService: QuotaService }): Promise<PluginBatchActionResult> {
  assertNameNotManaged(name);
  const { orgId, userId } = caller;
  return withPluginNameLock(orgId, name, async () => {
    const rows = await batchRows(orgId, name, batchId);
    if (rows.length === 0) throw new AppError(404, ErrorCode.NOT_FOUND, `No deleted versions of "${name}" in batch ${batchId}.`, { name, batchId });
    const done: PluginBatchActionResult['done'] = [];
    const skipped: PluginBatchActionResult['skipped'] = [];
    for (const row of rows) {
      const verdict = caller.checkWrite(row);
      if (verdict !== 'ok') {
        skipped.push({ id: row.id, version: row.version, reason: verdict });
        continue;
      }
      let purged: string | null;
      try {
        purged = await pluginService.purgeById(row.id, orgId);
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.PLUGIN_VERSION_IN_USE) {
          skipped.push({ id: row.id, version: row.version, reason: 'in_use' });
          continue;
        }
        throw err;
      }
      if (!purged) {
        skipped.push({ id: row.id, version: row.version, reason: 'not_purgeable' });
        continue;
      }
      // The row and its remediation rows are gone; the plugin service's purge
      // hook has removed its kept-source prefix and image (version-purge.ts).
      refundPluginSlot(opts.quotaService, row, caller.logWarn);
      done.push({ id: row.id, version: row.version });
      recordAudit({
        action: 'plugin.purge',
        actorId: actorId({ userId }),
        orgId,
        affectedOrgId: row.orgId,
        targetType: 'plugin',
        targetId: row.id,
        details: { pluginName: row.name, version: row.version, visibility: row.visibility, batchId },
      });
    }
    recordAudit({
      action: 'plugin.purge-all',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'plugin',
      targetId: name,
      details: { pluginName: name, batchId, done, skipped },
    });
    return { batchId, done, skipped };
  });
}

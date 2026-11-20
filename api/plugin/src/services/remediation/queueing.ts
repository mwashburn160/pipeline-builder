// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Queueing remediations at the end of a COMPLETED rescan pass (plan "End-to-end
 * flow" step 1, "Order and grouping", "Credits and quota"):
 *
 *  - targeted findings: every Critical/High at the configured severities with a
 *    fixed version, plus every KEV-listed one (isRemediationTarget), minus what
 *    a PLUGIN_VULN_WAIVERS entry exempts (VEX-covered findings never reach the
 *    summary). A version with none is not queued;
 *  - who may be changed (ecosystem `remediationOwnership`): an org's own plugin
 *    and the system org's (Official) are remediated under their org's
 *    pluginRemediation.mode (off → nothing); a third-party LISTED version gets a
 *    publisher fix request (N40) instead; a version the platform may not
 *    change (a managed toolchain release) goes straight to an owner request;
 *  - idempotency: one row per (version, findings hash) EVER — a failed set is
 *    not retried until its findings or their fixed versions change (the hash
 *    includes fixedIn); the live/active unique indexes refuse a second one;
 *  - one remediation per version per night (all its findings in one row), the
 *    daily per-org cap (PLUGIN_REMEDIATION_MAX_PER_ORG_PER_DAY), and the queue
 *    order KEV → EPSS → pipelines using the version, system org first;
 *  - the sweep: a live remediation whose owner uploaded a newer clean version
 *    is superseded (Stage 3 moves to the owner's version instead), and a fixed
 *    version no pipeline references any more is deactivated.
 */

import {
  compareRemediationPriority,
  createLogger,
  errorMessage,
  isManagedToolchainPlugin,
  isRemediationTarget,
  isSystemOrgId,
  pluginRemediationJobId,
  PLUGIN_REMEDIATION_JOB_NAME,
  remediationFindingsHash,
  remediationQueuePriority,
  scanFindingKey,
  SYSTEM_PLUGIN_REMEDIATION,
  type PluginRemediationJobData,
  type PluginScanFinding,
  type PluginScanSummary,
  type RemediationPriorityInput,
  type RemediationRemainingFinding,
} from '@pipeline-builder/api-core';
import { pipelinesOnVersion, schema, type PluginRemediation } from '@pipeline-builder/pipeline-data';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { isCanaryPlugin } from './canary.js';
import { removeQueuedRemediationJobs } from './cancel.js';
import { auditRemediation, countStage, sendOwnerRequest } from './lifecycle.js';
import { startTenantRollout } from './rollout.js';
import {
  elevatedTx, insertRemediation, liveRemediations, newestCleanOwnerVersion, readSettings, remediationExistsFor,
  remediationsCreatedSince, updateRemediation,
} from './store.js';
import { remediationConfig } from '../../config.js';
import { autoRemovalProtection, recordAutoRemovalSkip } from '../../helpers/auto-removal.js';
import { remediationOwnership, sendPublisherFixRequest } from '../ecosystem/remediation-fixes.js';

const logger = createLogger('plugin-remediation-queue');

/** A tenant plugin row the pass rescanned. */
export interface PluginCandidate {
  kind: 'plugin';
  id: string;
  orgId: string;
  name: string;
  version: string;
  imageDigest: string | null;
  deleted: boolean;
  yanked: boolean;
  createdBy: string | null;
  summary: PluginScanSummary;
}

/** A listed version the pass rescanned. */
export interface ListedCandidate {
  kind: 'listing_version';
  listingId: string;
  version: string;
  publisherHandle: string;
  summary: PluginScanSummary;
}

export type RemediationCandidate = PluginCandidate | ListedCandidate;

/** The findings a remediation targets in one summary. */
export function targetedFindings(summary: PluginScanSummary, severities: readonly ('critical' | 'high')[]): PluginScanFinding[] {
  const waived = new Set(summary.waived ?? []);
  return (summary.findings ?? []).filter((f) => !waived.has(scanFindingKey(f)) && isRemediationTarget(f, severities));
}

const toRemaining = (f: PluginScanFinding, reason: RemediationRemainingFinding['reason'], detail?: string): RemediationRemainingFinding => ({
  id: f.id,
  severity: f.severity,
  purl: f.purl,
  packageName: f.packageName,
  packageType: f.packageType,
  packageVersion: f.packageVersion,
  fixedIn: f.fixedIn,
  ...(f.kev ? { kev: true } : {}),
  reason,
  ...(detail ? { detail } : {}),
});

const SYSTEM_PRIORITY_CEILING = 1_000_501;

/** BullMQ priority: the system org (Official, the shared-base pass) ahead of every tenant; within each, KEV → EPSS → pipelines. */
export function queuePriority(orgId: string, p: RemediationPriorityInput): number {
  const half = Math.ceil(remediationQueuePriority(p) / 2);
  // half ≤ 1,000,501, so every tenant priority (≥ 1,000,502) sorts after every system one; the sum stays below BullMQ's 2^21.
  return isSystemOrgId(orgId) ? half : SYSTEM_PRIORITY_CEILING + half;
}

export interface QueueDeps {
  /** Add the job to the org's tier queue. */
  enqueue(orgId: string, data: PluginRemediationJobData, opts: { jobId: string; priority: number }): Promise<void>;
  now?: () => Date;
}

export interface QueuePassResult {
  queued: number;
  ownerRequests: number;
  publisherRequests: number;
  capped: number;
  superseded: number;
  deactivated: number;
}

export async function queuePassRemediations(candidates: readonly RemediationCandidate[], deps: QueueDeps): Promise<QueuePassResult> {
  const result: QueuePassResult = { queued: 0, ownerRequests: 0, publisherRequests: 0, capped: 0, superseded: 0, deactivated: 0 };
  const cfg = remediationConfig();
  if (!cfg.enabled) return result;
  const now = deps.now?.() ?? new Date();

  await sweepLive(result).catch((err) => logger.warn('Remediation sweep failed', { error: errorMessage(err) }));

  const modes = new Map<string, Awaited<ReturnType<typeof readSettings>>['mode']>();
  const used = new Map<string, number>();
  const queued: Array<{ row: PluginRemediation; priority: RemediationPriorityInput }> = [];

  for (const c of candidates) {
    try {
      const targeted = targetedFindings(c.summary, cfg.severities);
      if (targeted.length === 0) continue;

      if (c.kind === 'listing_version') {
        if (remediationOwnership({ kind: 'listing_version', publisherHandle: c.publisherHandle }) !== 'publisher_fix_request') continue;
        await sendPublisherFixRequest({ listingId: c.listingId, version: c.version, remaining: targeted.map((f) => toRemaining(f, 'third_party_listing')), suggestedPatchKey: null });
        result.publisherRequests++;
        continue;
      }
      if (c.deleted || c.yanked) continue;
      const org = c.orgId.toLowerCase();
      if (!modes.has(org)) modes.set(org, (await readSettings(org)).mode);
      if (modes.get(org) === 'off') continue;

      const canary = isCanaryPlugin(org, c.name);
      const hash = remediationFindingsHash(targeted);
      if (!canary && await remediationExistsFor(c.id, hash)) continue;
      if (!used.has(org)) used.set(org, await remediationsCreatedSince(org, now));
      if (used.get(org)! >= cfg.maxPerOrgPerDay) { result.capped++; continue; }

      const mayChange = !isManagedToolchainPlugin(c.name);
      const row = await insertRemediation({
        orgId: org,
        pluginId: c.id,
        pluginName: c.name,
        fromVersion: c.version,
        findingsHash: hash,
        targeted,
        createdBy: SYSTEM_PLUGIN_REMEDIATION,
        ...(mayChange ? {} : {
          stage: 'needs_owner' as const,
          outcome: 'owner_request' as const,
          finishedAt: now,
          remaining: targeted.map((f) => toRemaining(f, 'no_patcher', 'MANAGED_TOOLCHAIN')),
        }),
      });
      if (!row) continue; // already live / building for this version
      used.set(org, used.get(org)! + 1);
      auditRemediation('plugin.remediation.started', row, { findings: targeted.map((f) => f.id).slice(0, 200), targeted: targeted.length, ...(canary ? { canary: true } : {}) });
      if (!mayChange) {
        countStage('needs_owner', 'owner_request');
        await sendOwnerRequest(row, row.remaining ?? [], c.createdBy);
        result.ownerRequests++;
        continue;
      }
      countStage('queued', null);
      const pipelines = await pipelinesOnVersion({ pluginName: c.name, pluginVersion: c.version, imageDigest: c.imageDigest }).catch(() => []);
      queued.push({
        row,
        priority: {
          kev: targeted.some((f) => f.kev === true),
          maxEpss: targeted.reduce((m, f) => Math.max(m, typeof f.epss === 'number' ? f.epss : 0), 0),
          pipelineCount: pipelines.length,
        },
      });
    } catch (err) {
      logger.warn('Remediation not queued for one version', { ...(c.kind === 'plugin' ? { pluginId: c.id } : { listingId: c.listingId }), error: errorMessage(err) });
    }
  }

  queued.sort((a, b) => (isSystemOrgId(a.row.orgId) === isSystemOrgId(b.row.orgId) ? compareRemediationPriority(a.priority, b.priority) : isSystemOrgId(a.row.orgId) ? -1 : 1));
  for (const { row, priority } of queued) {
    try {
      await deps.enqueue(row.orgId, {
        kind: 'plugin-remediation', remediationId: row.id, orgId: row.orgId, pluginId: row.pluginId, pluginName: row.pluginName, fromVersion: row.fromVersion,
      }, { jobId: pluginRemediationJobId(row.id), priority: queuePriority(row.orgId, priority) });
      result.queued++;
    } catch (err) {
      // The row stays `queued`; POST …/retry (or the next findings change) re-queues it.
      logger.warn('Remediation job not enqueued', { remediationId: row.id, error: errorMessage(err) });
      await updateRemediation(row.id, { stage: 'failed', outcome: 'error', error: 'ENQUEUE_FAILED', finishedAt: new Date() }, ['queued']);
    }
  }
  return result;
}

/** The owner's newer clean version supersedes; a fixed version no pipeline uses any more is deactivated. */
async function sweepLive(result: QueuePassResult): Promise<void> {
  for (const row of await liveRemediations()) {
    const owner = await newestCleanOwnerVersion(row.orgId, row.pluginName, row.fromVersion, row.toVersion ? [row.toVersion] : []);
    if (owner) {
      const p = schema.plugin;
      const [ownerRow] = await elevatedTx((tx) => tx.select({ id: p.id }).from(p).where(and(eq(p.orgId, row.orgId), eq(p.name, row.pluginName), eq(p.version, owner))).limit(1)) as Array<{ id: string }>;
      const done = await updateRemediation(row.id, { stage: 'done', outcome: 'superseded', finishedAt: new Date(), error: null }, [row.stage]);
      if (!done) continue;
      result.superseded++;
      countStage('done', 'superseded');
      await removeQueuedRemediationJobs(row.id);
      // A rollout already under way moves to the owner's version instead (supersedes the open proposals).
      if (ownerRow && (row.stage === 'published' || row.stage === 'rolling_out' || row.stage === 'needs_review')) {
        await startTenantRollout(row, { toVersion: owner, toPluginId: ownerRow.id });
      }
      continue;
    }
    if (row.toPluginId && (row.stage === 'rolling_out' || row.stage === 'published')) {
      if (await deactivateIfUnreferenced(row)) result.deactivated++;
    }
  }
}

/**
 * Whether `row`'s version is its plugin's only non-deleted version — protected
 * from every automatic removal or deactivation by the shared rule
 * (helpers/auto-removal.ts), and the skip counted like every other automatic
 * path's. Deactivation is the step that takes an ACTIVE version out of use, so
 * only the rule's only-version half applies here.
 */
async function onlyRemainingVersion(row: Pick<PluginRemediation, 'pluginId' | 'orgId' | 'pluginName' | 'fromVersion'>): Promise<boolean> {
  const p = schema.plugin;
  const others = await elevatedTx((tx) => tx.select({ id: p.id }).from(p)
    .where(and(eq(p.orgId, row.orgId), eq(p.name, row.pluginName), isNull(p.deletedAt), ne(p.id, row.pluginId))).limit(1)) as unknown[];
  if (autoRemovalProtection({ isActive: false, deletedAt: null, otherLiveVersions: others.length }) !== 'only_version') return false;
  recordAutoRemovalSkip('only_version', { path: 'remediation_deactivate', orgId: row.orgId, name: row.pluginName, version: row.fromVersion });
  return true;
}

/**
 * Deactivate the flagged version once no pipeline references it — never the
 * plugin's only remaining version; it stays stored, flagged and restorable,
 * with its kept source. Remediation never deletes anything.
 */
export async function deactivateIfUnreferenced(row: Pick<PluginRemediation, 'pluginId' | 'orgId' | 'pluginName' | 'fromVersion'>): Promise<boolean> {
  const p = schema.plugin;
  const [from] = await elevatedTx((tx) => tx.select({ isActive: p.isActive, imageDigest: p.imageDigest }).from(p).where(eq(p.id, row.pluginId)).limit(1)) as Array<{ isActive: boolean; imageDigest: string | null }>;
  if (!from?.isActive) return false;
  // Never the plugin's only remaining version (automatic paths never take a plugin's last version out of use).
  if (await onlyRemainingVersion(row)) return false;
  const using = await pipelinesOnVersion({ pluginName: row.pluginName, pluginVersion: row.fromVersion, imageDigest: from.imageDigest });
  if (using.length > 0) return false;
  await elevatedTx((tx) => tx.update(p).set({ isActive: false, updatedAt: new Date(), updatedBy: SYSTEM_PLUGIN_REMEDIATION }).where(eq(p.id, row.pluginId)));
  logger.info('Flagged version deactivated: its fix is published and no pipeline references it', { pluginId: row.pluginId });
  return true;
}

export { PLUGIN_REMEDIATION_JOB_NAME };

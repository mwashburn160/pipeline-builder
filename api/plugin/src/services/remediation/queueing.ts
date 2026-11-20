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
 *    publisher fix request (N40) instead; a managed toolchain release is ONE
 *    `kind = 'toolchain'` remediation per release (both halves' findings, on
 *    its pipeline-bootstrap row) under PLUGIN_REMEDIATION_TOOLCHAINS=propose —
 *    a propose-only release candidate (toolchain.ts) — and goes straight to an
 *    owner request under `off`;
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
  MANAGED_TOOLCHAIN,
  pluginRemediationJobId,
  PLUGIN_REMEDIATION_JOB_NAME,
  remediationFindingsHash,
  remediationQueuePriority,
  scanFindingKey,
  SYSTEM_ORG_ID,
  SYSTEM_PLUGIN_REMEDIATION,
  type PluginRemediationJobData,
  type PluginScanFinding,
  type PluginScanSummary,
  type RemediationPriorityInput,
  type RemediationRemainingFinding,
} from '@pipeline-builder/api-core';
import { pipelinesOnVersion, schema, type Plugin, type PluginRemediation } from '@pipeline-builder/pipeline-data';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { isCanaryPlugin } from './canary.js';
import { removeQueuedRemediationJobs } from './cancel.js';
import { auditRemediation, countStage, sendOwnerRequest } from './lifecycle.js';
import { startTenantRollout } from './rollout.js';
import {
  elevatedTx, insertRemediationUnderCap, isRolloutStage, liveRemediations, newestCleanOwnerVersion, readSettings, remediationExistsFor,
  updateRemediation,
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
  /** Discard a superseded toolchain candidate's images (default: the live registry ports). */
  discardToolchainCandidate?: (row: PluginRemediation) => Promise<void>;
  /** Resume approved toolchain candidates whose publish was interrupted (default: the live ports). */
  resumeToolchainFixes?: () => Promise<number>;
  /** Whether a remediation still has a waiting / active / delayed job in any tier queue (default: the live queues). */
  hasLiveJob?: (row: PluginRemediation) => Promise<boolean>;
}

/** A queued / building / approved row untouched this long with no live job is STRANDED (a lost enqueue, a crashed worker). */
export const STRANDED_REMEDIATION_AFTER_MS = 3 * 3_600_000;
/** How many times the sweep re-enqueues one stranded remediation before failing it `STRANDED`. */
export const MAX_STRANDED_REQUEUES = 3;
const STRANDED_MARK = 'STRANDED_REQUEUE:';
const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

/** The job a stranded row needs: its build, or (approved, not yet published) its approved run. */
function strandedJob(row: PluginRemediation): { jobId: string; priority: number } | null {
  if (row.stage === 'queued' || row.stage === 'rebuild' || row.stage === 'libraries') {
    const kev = (row.targeted ?? []).some((f) => f.kev === true);
    return { jobId: pluginRemediationJobId(row.id), priority: queuePriority(row.orgId, { kev, maxEpss: 0, pipelineCount: 0 }) };
  }
  // A toolchain candidate's approved publish has its own lease and resume scheduler.
  if (row.stage === 'awaiting_approval' && row.decidedAt && row.kind !== 'toolchain') return { jobId: `${pluginRemediationJobId(row.id)}-approved`, priority: 1 };
  return null;
}

async function liveHasJob(row: PluginRemediation): Promise<boolean> {
  const { getAllTierQueues } = await import('../../queue/connections.js');
  const ids = [pluginRemediationJobId(row.id), `${pluginRemediationJobId(row.id)}-approved`];
  for (const { queue } of getAllTierQueues()) {
    for (const id of ids) {
      const job = await queue.getJob(id);
      if (job && LIVE_JOB_STATES.has(await job.getState())) return true;
    }
  }
  return false;
}

/**
 * A row in queued / rebuild / libraries, or approved and awaiting its run, that
 * has not moved for {@link STRANDED_REMEDIATION_AFTER_MS} and has no live job
 * would block that version forever (the active-version unique index). It is
 * re-enqueued (any dead job of that id removed first), at most
 * {@link MAX_STRANDED_REQUEUES} times — counted in its `error` as
 * `STRANDED_REQUEUE:<n>` — then failed with `STRANDED` (retryable).
 */
async function recoverStranded(row: PluginRemediation, result: QueuePassResult, deps: Pick<QueueDeps, 'enqueue' | 'hasLiveJob'>, now: Date): Promise<void> {
  const job = strandedJob(row);
  if (!job || row.updatedAt.getTime() > now.getTime() - STRANDED_REMEDIATION_AFTER_MS) return;
  if (await (deps.hasLiveJob ?? liveHasJob)(row)) return;
  const n = row.error?.startsWith(STRANDED_MARK) ? Number(row.error.slice(STRANDED_MARK.length)) || 0 : 0;
  if (n >= MAX_STRANDED_REQUEUES) {
    const failed = await updateRemediation(row.id, { stage: 'failed', outcome: 'error', error: 'STRANDED', finishedAt: new Date() }, [row.stage]);
    if (!failed) return;
    countStage('failed', 'error');
    result.stranded++;
    logger.warn('Stranded remediation failed after its re-enqueues', { remediationId: row.id, stage: row.stage, requeues: n });
    return;
  }
  const marked = await updateRemediation(row.id, { error: `${STRANDED_MARK}${n + 1}` }, [row.stage]);
  if (!marked) return;
  await removeQueuedRemediationJobs(row.id);
  await deps.enqueue(row.orgId, {
    kind: 'plugin-remediation', remediationId: row.id, orgId: row.orgId, pluginId: row.pluginId, pluginName: row.pluginName, fromVersion: row.fromVersion,
  }, job);
  result.requeued++;
  logger.warn('Stranded remediation re-enqueued', { remediationId: row.id, stage: row.stage, requeue: n + 1 });
}

async function liveResumeToolchainFixes(): Promise<number> {
  const [{ resumeStuckToolchainFixes }, { liveToolchainPorts }] = await Promise.all([import('./toolchain.js'), import('./tooling.js')]);
  return resumeStuckToolchainFixes({ ports: liveToolchainPorts() });
}

async function liveDiscardToolchainCandidate(row: PluginRemediation): Promise<void> {
  const [{ discardToolchainCandidate }, { liveRemediationPorts }] = await Promise.all([import('./toolchain.js'), import('./tooling.js')]);
  await discardToolchainCandidate(row, liveRemediationPorts());
}

/** The targeted findings of one toolchain release, collected across both halves during a pass. */
interface ToolchainPending { bootstrapId: string | null; targeted: Map<string, PluginScanFinding>; imageDigest: string | null }

export interface QueuePassResult {
  queued: number;
  ownerRequests: number;
  publisherRequests: number;
  capped: number;
  superseded: number;
  deactivated: number;
  /** Stranded rows re-enqueued this pass. */
  requeued: number;
  /** Stranded rows failed (`STRANDED`) after their re-enqueues. */
  stranded: number;
}

export async function queuePassRemediations(candidates: readonly RemediationCandidate[], deps: QueueDeps): Promise<QueuePassResult> {
  const result: QueuePassResult = { queued: 0, ownerRequests: 0, publisherRequests: 0, capped: 0, superseded: 0, deactivated: 0, requeued: 0, stranded: 0 };
  const cfg = remediationConfig();
  if (!cfg.enabled) return result;
  const now = deps.now?.() ?? new Date();

  await sweepLive(result, deps, now).catch((err) => logger.warn('Remediation sweep failed', { error: errorMessage(err) }));
  // An approved toolchain candidate whose publish crashed part-way resumes here (idempotent, same version).
  await (deps.resumeToolchainFixes ?? liveResumeToolchainFixes)().catch((err) => logger.warn('Toolchain fix resume sweep failed', { error: errorMessage(err) }));

  const modes = new Map<string, Awaited<ReturnType<typeof readSettings>>['mode']>();
  const cappedOrgs = new Set<string>();
  const queued: Array<{ row: PluginRemediation; priority: RemediationPriorityInput }> = [];
  const toolchains = new Map<string, ToolchainPending>();

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

      // A managed toolchain release under propose: one remediation per release, after the loop.
      if (cfg.toolchains === 'propose' && isSystemOrgId(org) && isManagedToolchainPlugin(c.name)) {
        const t = toolchains.get(c.version) ?? { bootstrapId: null, targeted: new Map(), imageDigest: null };
        if (c.name.toLowerCase() === MANAGED_TOOLCHAIN.bootstrap) { t.bootstrapId = c.id; t.imageDigest = c.imageDigest; }
        for (const f of targeted) if (!t.targeted.has(`${f.id}|${f.purl}`)) t.targeted.set(`${f.id}|${f.purl}`, f);
        toolchains.set(c.version, t);
        continue;
      }

      const canary = isCanaryPlugin(org, c.name);
      const hash = remediationFindingsHash(targeted);
      if (!canary && await remediationExistsFor(c.id, hash)) continue;
      if (cappedOrgs.has(org)) { result.capped++; continue; }

      const mayChange = !isManagedToolchainPlugin(c.name);
      // Count and insert under the org's cap lock (the same one retry takes).
      const inserted = await insertRemediationUnderCap({
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
      }, cfg.maxPerOrgPerDay, { now });
      if (inserted.status === 'capped') { cappedOrgs.add(org); result.capped++; continue; }
      if (inserted.status !== 'inserted') continue; // already live / building for this version
      const row = inserted.row;
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

  for (const [release, t] of toolchains) {
    try {
      const row = await queueToolchainRelease(release, t, cappedOrgs, now, result);
      if (row) queued.push(row);
    } catch (err) {
      logger.warn('Toolchain remediation not queued', { release, error: errorMessage(err) });
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

/**
 * One toolchain release's remediation: on its pipeline-bootstrap row (found
 * when only cdk-synth was flagged tonight), both halves' targeted findings,
 * idempotent per findings set like any remediation, under the system org's
 * daily cap.
 */
async function queueToolchainRelease(
  release: string,
  t: ToolchainPending,
  cappedOrgs: Set<string>,
  now: Date,
  result: QueuePassResult,
): Promise<{ row: PluginRemediation; priority: RemediationPriorityInput } | null> {
  const org = SYSTEM_ORG_ID.toLowerCase();
  let bootstrapId = t.bootstrapId;
  let imageDigest = t.imageDigest;
  if (!bootstrapId) {
    const p = schema.plugin;
    const [bs] = await elevatedTx((tx) => tx.select({ id: p.id, imageDigest: p.imageDigest }).from(p).where(and(
      eq(p.orgId, SYSTEM_ORG_ID), eq(p.name, MANAGED_TOOLCHAIN.bootstrap), eq(p.version, release), isNull(p.deletedAt),
    )).limit(1)) as Array<Pick<Plugin, 'id' | 'imageDigest'>>;
    if (!bs) return null;
    bootstrapId = bs.id;
    imageDigest = bs.imageDigest ?? null;
  }
  const targeted = [...t.targeted.values()];
  const hash = remediationFindingsHash(targeted);
  if (await remediationExistsFor(bootstrapId, hash)) return null;
  if (cappedOrgs.has(org)) { result.capped++; return null; }
  const inserted = await insertRemediationUnderCap({
    orgId: org,
    pluginId: bootstrapId,
    pluginName: MANAGED_TOOLCHAIN.bootstrap,
    fromVersion: release,
    findingsHash: hash,
    targeted,
    kind: 'toolchain',
    createdBy: SYSTEM_PLUGIN_REMEDIATION,
  }, remediationConfig().maxPerOrgPerDay, { now });
  if (inserted.status === 'capped') { cappedOrgs.add(org); result.capped++; return null; }
  if (inserted.status !== 'inserted') return null; // a candidate for this release is already building or awaiting a decision
  const row = inserted.row;
  auditRemediation('plugin.remediation.started', row, { kind: 'toolchain', findings: targeted.map((f) => f.id).slice(0, 200), targeted: targeted.length });
  countStage('queued', null);
  const pipelines = await pipelinesOnVersion({ pluginName: MANAGED_TOOLCHAIN.bootstrap, pluginVersion: release, imageDigest }).catch(() => []);
  return {
    row,
    priority: {
      kev: targeted.some((f) => f.kev === true),
      maxEpss: targeted.reduce((m, f) => Math.max(m, typeof f.epss === 'number' ? f.epss : 0), 0),
      pipelineCount: pipelines.length,
    },
  };
}

/** The owner's newer clean version supersedes; a fixed version no pipeline uses any more is deactivated. */
async function sweepLive(result: QueuePassResult, deps: Pick<QueueDeps, 'discardToolchainCandidate' | 'enqueue' | 'hasLiveJob'>, now: Date): Promise<void> {
  for (const row of await liveRemediations()) {
    // An approved toolchain candidate is publishing (or resumes): a newer release never cancels it half-way.
    if (row.kind === 'toolchain' && row.toolchainCandidate?.publish) continue;
    const owner = await newestCleanOwnerVersion(row.orgId, row.pluginName, row.fromVersion, row.toVersion ? [row.toVersion] : []);
    if (owner) {
      const p = schema.plugin;
      const [ownerRow] = await elevatedTx((tx) => tx.select({ id: p.id }).from(p).where(and(eq(p.orgId, row.orgId), eq(p.name, row.pluginName), eq(p.version, owner))).limit(1)) as Array<{ id: string }>;
      const done = await updateRemediation(row.id, { stage: 'done', outcome: 'superseded', finishedAt: new Date(), error: null }, [row.stage]);
      if (!done) continue;
      result.superseded++;
      countStage('done', 'superseded');
      await removeQueuedRemediationJobs(row.id);
      // A toolchain candidate superseded by a newer release: its images go; it never rolls out.
      if (row.kind === 'toolchain') {
        await (deps.discardToolchainCandidate ?? liveDiscardToolchainCandidate)(row).catch((err) => logger.warn('Superseded toolchain candidate not discarded', { remediationId: row.id, error: errorMessage(err) }));
        continue;
      }
      // A rollout already under way moves to the owner's version instead (supersedes the open proposals).
      if (ownerRow && isRolloutStage(row.stage)) {
        await startTenantRollout(row, { toVersion: owner, toPluginId: ownerRow.id });
      }
      continue;
    }
    if (row.toPluginId && (row.stage === 'rolling_out' || row.stage === 'published')) {
      if (await deactivateIfUnreferenced(row)) result.deactivated++;
      continue;
    }
    await recoverStranded(row, result, deps, now).catch((err) => logger.warn('Stranded remediation not recovered', { remediationId: row.id, error: errorMessage(err) }));
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

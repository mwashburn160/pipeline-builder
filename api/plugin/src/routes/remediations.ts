// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly plugin CVE remediation routes (docs/plugin-publishing.md "Scan
 * gates"), mounted at `/plugins` behind the shared auth + org chain and BEFORE
 * the read routes (their `/:id` would catch `remediations`). Each route owns its
 * gate; the two decisions layer their OWN step-up:
 *
 *   GET  /plugins/remediations                     plugins:read   list (filter by stage, plugin), the operator knob, today's cap use
 *   GET  /plugins/remediations/:id                 plugins:read   one (own org; 404 otherwise)
 *   GET  /plugins/remediations/:id/patch           plugins:read   the remediation.diff (text/x-diff attachment; never the ZIP)
 *   GET  /plugins/remediations/:id/export          system org + plugins:write   an Official fix's deploy/plugins/** export
 *   POST /plugins/remediations/:id/approve         plugins:write + step-up   awaiting_approval → re-run, verify and publish (503 while the operator knob is off; 409 PLUGIN_REMEDIATION_MODE_OFF while the org's mode is off)
 *   POST /plugins/remediations/:id/reject          plugins:write + step-up   awaiting_approval → failed / rejected
 *   POST /plugins/remediations/:id/retry           plugins:write + step-up   failed | needs_owner | needs_review → a new attempt (counts toward the daily cap, held under a per-org lock; 503 / 409 like approve);
 *                                                                             published with error rollout_start_failed → its rollout started again in place
 *   GET  /plugins/remediation-settings             plugins:read   the org's pluginRemediation settings
 *   PUT  /plugins/remediation-settings             org_settings:write
 *   PUT  /plugins/by-name/:name/remediation-level  plugins:write  a plugin's own library upgrade level (null = Follow organization)
 */

import {
  attachmentDisposition,
  audited,
  ErrorCode,
  hasPermission,
  isPluginRemediationStage,
  normalizePluginRemediationSettings,
  PluginRemediationDecisionSchema,
  PluginRemediationLevelWriteSchema,
  PluginRemediationListQuerySchema,
  PluginRemediationSettingsWriteSchema,
  pluginRemediationJobId,
  recordAudit,
  REMEDIATION_ROLLOUT_START_FAILED,
  requirePermission,
  requireStepUp,
  requireSystemOrg,
  sendSuccess,
  validate,
  type Permission,
  type PluginRemediationStage,
} from '@pipeline-builder/api-core';
import { schema, type PluginRemediation } from '@pipeline-builder/pipeline-data';
import { and, eq } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';

import { bodyFrom, ecosystemRoute, param } from './ecosystem-route.js';
import { remediationConfig } from '../config.js';
import { enqueueApprovedRun, enqueueRemediationJob } from '../queue/plugin-remediation.js';
import { EcosystemError, type Caller } from '../services/ecosystem/context.js';
import { readRemediationArtifact, type ArtifactReader } from '../services/remediation/artifacts.js';
import { toRemediationDto } from '../services/remediation/dto.js';
import { auditRemediation, countStage } from '../services/remediation/lifecycle.js';
import { queuePriority } from '../services/remediation/queueing.js';
import { recordRolloutStart } from '../services/remediation/rollout-start.js';
import { startTenantRollout } from '../services/remediation/rollout.js';
import {
  getOrgRemediation, insertRemediationUnderCap, listRemediations, readSettings, readSettingsRow, remediationsCreatedSince, updateRemediation, writeSettings,
} from '../services/remediation/store.js';

export type { ArtifactReader };
/** The stored-artifact reader (swappable in tests). */
let readArtifact: ArtifactReader = readRemediationArtifact;
export function setRemediationArtifactReaderForTests(r?: ArtifactReader): void { readArtifact = r ?? readRemediationArtifact; }

/** The stages POST …/retry starts a new attempt from. */
const RETRYABLE_STAGES = ['failed', 'needs_owner', 'needs_review'] as const satisfies readonly PluginRemediationStage[];

const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/;

const disabled = (): EcosystemError => new EcosystemError(ErrorCode.SERVICE_UNAVAILABLE, 'Plugin remediation is turned off by the operator');
/** The org's pluginRemediation.mode is off: nothing would run for it, so approving or retrying is refused. */
async function assertOrgModeOn(caller: Caller): Promise<void> {
  const { mode } = await readSettings(caller.orgId, !!caller.parentOrgId);
  if (mode === 'off') {
    throw new EcosystemError(ErrorCode.PLUGIN_REMEDIATION_MODE_OFF, 'Plugin remediation is turned off for this organization (Settings → Plugin security fixes); turn it on to approve or retry', { mode });
  }
}
const notFound = (): EcosystemError => new EcosystemError(ErrorCode.NOT_FOUND, 'Remediation not found');
const stageConflict = (stage: string): EcosystemError => new EcosystemError(ErrorCode.REMEDIATION_STAGE_CONFLICT, `Not possible while the remediation is ${stage}`, { stage });
/**
 * The version it fixed was purged (`plugin_id` NULL): the record of a published
 * fix stays readable, but nothing is left to rebuild or re-verify.
 */
const sourcePurged = (row: PluginRemediation): EcosystemError => new EcosystemError(ErrorCode.REMEDIATION_STAGE_CONFLICT,
  `${row.pluginName}@${row.fromVersion} was purged; this remediation can no longer be approved or retried`, { stage: row.stage, reason: 'source_version_purged' });
/** A toolchain release candidate is decided only by the system org's toolchain-fixes routes (it is never re-run and published from here). */
const toolchainCandidate = (): EcosystemError => new EcosystemError(ErrorCode.REMEDIATION_STAGE_CONFLICT, 'A toolchain release candidate is approved or rejected under /plugins/toolchain-fixes', { stage: 'toolchain_candidate' });

async function ownRemediation(caller: Caller, id: string): Promise<PluginRemediation> {
  const row = await getOrgRemediation(caller.orgId, id);
  if (!row) throw notFound();
  return row;
}

function sendText(res: Response, body: string, filename: string): void {
  res.setHeader('Content-Type', 'text/x-diff; charset=utf-8');
  res.setHeader('Content-Disposition', attachmentDisposition(filename));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(body);
}

/**
 * Retry on a `published` fix whose rollout start was given up
 * (`rollout_start_failed`): the same row's rollout is started again in place
 * (no new attempt, nothing rebuilt, the daily cap untouched), counting from 1 —
 * taken → rolling_out with the error cleared; a transient failure clears the
 * error and leaves it to the nightly sweep; a permanent one keeps the error.
 * Answers the row either way (202); the card says which.
 */
async function restartRolloutStart(row: PluginRemediation, caller: Caller, res: Response): Promise<void> {
  if (!row.toPluginId) {
    throw new EcosystemError(ErrorCode.REMEDIATION_STAGE_CONFLICT, `${row.pluginName}@${row.toVersion ?? ''} was purged; there is no fix version left to roll out`, { stage: row.stage, reason: 'fix_version_purged' });
  }
  if (!remediationConfig().enabled) throw disabled();
  await assertOrgModeOn(caller);
  const recorded = await recordRolloutStart(row, await startTenantRollout(row), 'manual');
  if (!recorded.row) throw stageConflict('changing');
  const start = toRemediationDto(recorded.row).rolloutStart;
  auditRemediation('plugin.remediation.retried', recorded.row, {
    rolloutRestart: true,
    started: recorded.outcome === 'started',
    ...(start?.lastStatus ? { lastStartStatus: start.lastStatus } : {}),
  }, caller.userId);
  sendSuccess(res, 202, toRemediationDto(recorded.row));
}

export function createRemediationRoutes(): Router {
  const router = Router();
  const read = requirePermission('plugins:read') as RequestHandler;
  const write = requirePermission('plugins:write') as RequestHandler;

  router.get('/remediations', read, ecosystemRoute(async ({ req, res, caller }) => {
    const q = validate(req.query, PluginRemediationListQuerySchema);
    if (!q.ok) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, q.error);
    const stages = q.value.stage ? q.value.stage.split(',').map((s) => s.trim()).filter(isPluginRemediationStage) as PluginRemediationStage[] : undefined;
    const page = await listRemediations({ orgId: caller.orgId, ...(stages ? { stages } : {}), ...(q.value.pluginId ? { pluginId: q.value.pluginId } : {}), ...(q.value.pluginName ? { pluginName: q.value.pluginName } : {}), limit: q.value.limit ?? 50, ...(q.value.cursor ? { cursor: q.value.cursor } : {}) });
    const cfg = remediationConfig();
    sendSuccess(res, 200, {
      remediations: page.rows.map(toRemediationDto),
      nextCursor: page.nextCursor,
      enabled: cfg.enabled,
      severities: cfg.severities,
      usedToday: await remediationsCreatedSince(caller.orgId),
      maxPerDay: cfg.maxPerOrgPerDay,
    });
  }));

  router.get('/remediations/:id', read, ecosystemRoute(async ({ req, res, caller }) => {
    sendSuccess(res, 200, toRemediationDto(await ownRemediation(caller, param(req, 'id'))));
  }));

  router.get('/remediations/:id/patch', read, ecosystemRoute(async ({ req, res, caller }) => {
    const row = await ownRemediation(caller, param(req, 'id'));
    const body = row.patchKey ? await readArtifact(row.patchKey) : null;
    if (body === null) throw new EcosystemError(ErrorCode.NOT_FOUND, 'This remediation has no stored patch');
    sendText(res, body, `${row.pluginName}-${row.fromVersion}-remediation.diff`);
  }));

  // System org only: the gate is the system-org check plus plugins:write (plugins:write is
  // not a system-org-only permission, so requireSystemOrgPermission cannot take it).
  router.get('/remediations/:id/export', requireSystemOrg as RequestHandler, write, ecosystemRoute(async ({ req, res, caller }) => {
    const row = await ownRemediation(caller, param(req, 'id'));
    const body = row.exportKey ? await readArtifact(row.exportKey) : null;
    if (body === null) throw new EcosystemError(ErrorCode.NOT_FOUND, 'This remediation has no stored export');
    sendText(res, body, `${row.pluginName}-${row.fromVersion}-export.diff`);
  }));

  router.post('/remediations/:id/approve', write, requireStepUp as RequestHandler, audited('plugin.remediation.approved') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const { reason } = bodyFrom(req, PluginRemediationDecisionSchema);
    const row = await ownRemediation(caller, param(req, 'id'));
    if (row.kind === 'toolchain') throw toolchainCandidate();
    if (row.stage !== 'awaiting_approval' || row.decidedAt) throw stageConflict(row.decidedAt ? 'approved and publishing' : row.stage);
    if (!row.pluginId) throw sourcePurged(row);
    // The approved run is the job's: with the operator knob off it would never run.
    if (!remediationConfig().enabled) throw disabled();
    await assertOrgModeOn(caller);
    const decided = await updateRemediation(row.id, { decidedBy: caller.userId, decidedAt: new Date(), decisionReason: reason ?? null }, ['awaiting_approval'], { undecided: true });
    if (!decided) throw stageConflict('changing');
    auditRemediation('plugin.remediation.approved', decided, { ...(reason ? { reason } : {}) }, caller.userId);
    // The approved fix is rebuilt, re-verified and published by the job.
    await enqueueApprovedRun(decided);
    sendSuccess(res, 202, toRemediationDto(decided));
  }));

  router.post('/remediations/:id/reject', write, requireStepUp as RequestHandler, audited('plugin.remediation.rejected') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const { reason } = bodyFrom(req, PluginRemediationDecisionSchema);
    const row = await ownRemediation(caller, param(req, 'id'));
    if (row.kind === 'toolchain') throw toolchainCandidate();
    if (row.stage !== 'awaiting_approval' || row.decidedAt) throw stageConflict(row.stage);
    const done = await updateRemediation(row.id, {
      stage: 'failed', outcome: 'rejected', decidedBy: caller.userId, decidedAt: new Date(), decisionReason: reason ?? null, finishedAt: new Date(),
    }, ['awaiting_approval']);
    if (!done) throw stageConflict('changing');
    countStage('failed', 'rejected');
    auditRemediation('plugin.remediation.rejected', done, { ...(reason ? { reason } : {}) }, caller.userId);
    sendSuccess(res, 200, toRemediationDto(done));
  }));

  router.post('/remediations/:id/retry', write, requireStepUp as RequestHandler, audited('plugin.remediation.retried', 'plugin.remediation.started') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const row = await ownRemediation(caller, param(req, 'id'));
    if (row.stage === 'published' && row.error === REMEDIATION_ROLLOUT_START_FAILED) {
      await restartRolloutStart(row, caller, res);
      return;
    }
    if (!(RETRYABLE_STAGES as readonly string[]).includes(row.stage)) throw stageConflict(row.stage);
    if (!row.pluginId) throw sourcePurged(row);
    const cfg = remediationConfig();
    if (!cfg.enabled) throw disabled();
    await assertOrgModeOn(caller);
    // Count and insert under one per-org lock: concurrent retries never exceed the cap together.
    const inserted = await insertRemediationUnderCap({
      orgId: row.orgId,
      pluginId: row.pluginId,
      pluginName: row.pluginName,
      fromVersion: row.fromVersion,
      findingsHash: row.findingsHash,
      targeted: row.targeted,
      attempt: row.attempt + 1,
      retryOf: row.id,
      // A toolchain release candidate retries as one (propose-only, never published by the job).
      kind: row.kind,
      createdBy: caller.userId,
    }, cfg.maxPerOrgPerDay, {
      // A paused rollout keeps its version; its row closes (in the same transaction) so the new attempt can be live.
      beforeInsert: row.stage === 'needs_review'
        ? async (tx) => { await tx.update(schema.pluginRemediation).set({ stage: 'done', outcome: 'superseded', finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.pluginRemediation.id, row.id), eq(schema.pluginRemediation.stage, 'needs_review'))); }
        : undefined,
    });
    if (inserted.status === 'capped') {
      throw new EcosystemError(ErrorCode.QUOTA_EXCEEDED, `This organization has used its ${cfg.maxPerOrgPerDay} remediations for today`, { used: inserted.used, limit: cfg.maxPerOrgPerDay });
    }
    // Copied from the org's own row, so this never fires unless a row was corrupted: answered like another org's.
    if (inserted.status === 'refused') throw new EcosystemError(ErrorCode.NOT_FOUND, 'The version this remediation fixes is not in your organization');
    const next = inserted.status === 'inserted' ? inserted.row : null;
    if (!next) throw stageConflict('already being remediated');
    countStage('queued', null);
    auditRemediation('plugin.remediation.retried', next, { retryOf: row.id }, caller.userId);
    auditRemediation('plugin.remediation.started', next, { retryOf: row.id, findings: (row.targeted ?? []).map((f) => f.id).slice(0, 200) }, caller.userId);
    const kev = (row.targeted ?? []).some((f) => f.kev === true);
    await enqueueRemediationJob(next.orgId, {
      kind: 'plugin-remediation', remediationId: next.id, orgId: next.orgId, pluginId: next.pluginId, pluginName: next.pluginName, fromVersion: next.fromVersion,
    }, { jobId: pluginRemediationJobId(next.id), priority: queuePriority(next.orgId, { kev, maxEpss: 0, pipelineCount: 0 }) });
    sendSuccess(res, 202, toRemediationDto(next));
  }));

  // -- settings ----------------------------------------------------------------------

  router.get('/remediation-settings', read, ecosystemRoute(async ({ res, caller }) => {
    const isTeam = !!caller.parentOrgId;
    const settings = normalizePluginRemediationSettings(await readSettingsRow(caller.orgId), { isTeam });
    const root = isTeam ? normalizePluginRemediationSettings(await readSettingsRow(caller.parentOrgId!), { isTeam: false }) : null;
    const cfg = remediationConfig();
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, 200, {
      settings,
      isTeam,
      root: root ? { rollout: root.rollout, allowPipelineApply: root.allowPipelineApply } : null,
      enabled: cfg.enabled,
      severities: cfg.severities,
      canEdit: hasPermission(caller.permissions as Permission[], 'org_settings:write', caller.isSuperAdmin),
    });
  }));

  router.put('/remediation-settings', requirePermission('org_settings:write') as RequestHandler, audited('plugin.remediation_settings.update') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const body = bodyFrom(req, PluginRemediationSettingsWriteSchema);
    const isTeam = !!caller.parentOrgId;
    if (!isTeam && body.rollout === 'inherit') throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'rollout: a root organization cannot inherit');
    if (isTeam && body.allowPipelineApply !== undefined) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'allowPipelineApply is set on the root organization');
    const beforeRow = await readSettingsRow(caller.orgId);
    const before = normalizePluginRemediationSettings(beforeRow, { isTeam });
    const byType = { ...before.libraryUpgradeLevelByType };
    for (const [t, l] of Object.entries(body.libraryUpgradeLevelByType ?? {})) {
      if (l === null) delete byType[t as keyof typeof byType]; else byType[t as keyof typeof byType] = l;
    }
    const row = await writeSettings(caller.orgId, {
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.libraryUpgradeLevel ? { libraryUpgradeLevel: body.libraryUpgradeLevel } : {}),
      ...(body.libraryUpgradeLevelByType ? { libraryUpgradeLevelByType: byType } : {}),
      ...(body.rollout ? { rollout: body.rollout } : {}),
      ...(body.allowPipelineApply !== undefined ? { allowPipelineApply: body.allowPipelineApply } : {}),
    }, caller.userId);
    const after = normalizePluginRemediationSettings(row, { isTeam });
    recordAudit({ action: 'plugin.remediation_settings.update', actorId: caller.userId, orgId: caller.orgId, targetType: 'org', targetId: caller.orgId, details: { before, after } });
    sendSuccess(res, 200, { settings: after });
  }));

  router.put('/by-name/:name/remediation-level', write, audited('plugin.remediation_level.update') as RequestHandler, ecosystemRoute(async ({ req, res, caller }) => {
    const name = param(req, 'name');
    if (!PLUGIN_NAME.test(name)) throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'name must be a plugin name');
    const { level } = bodyFrom(req, PluginRemediationLevelWriteSchema);
    const current = normalizePluginRemediationSettings(await readSettingsRow(caller.orgId), { isTeam: !!caller.parentOrgId });
    const byPlugin = { ...current.libraryUpgradeLevelByPlugin };
    const before = byPlugin[name] ?? null;
    if (level === null) delete byPlugin[name]; else byPlugin[name] = level;
    await writeSettings(caller.orgId, { libraryUpgradeLevelByPlugin: byPlugin }, caller.userId);
    recordAudit({ action: 'plugin.remediation_level.update', actorId: caller.userId, orgId: caller.orgId, targetType: 'plugin', targetId: name, details: { pluginName: name, before, after: level } });
    sendSuccess(res, 200, { name, level });
  }));

  return router;
}

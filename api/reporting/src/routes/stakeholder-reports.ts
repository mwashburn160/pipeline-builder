// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stakeholder reports — the authoring and publishing API.
 *
 * Mounted under `/reports/stakeholder` behind auth + orgId + tenant context +
 * `requireFeature('stakeholder_reports')`. Three permissions divide the surface,
 * and the split is the point:
 *
 *  - `reports:read`   — look at definitions, runs and the distribution list.
 *  - `reports:author` — save, schedule, draft and annotate. Composing a report.
 *  - `reports:share`  — PUBLISH, and mint the links that let someone without an
 *    account read it. Publishing is the moment internal delivery numbers leave
 *    the platform, which is a different decision from writing them down, so it is
 *    a different permission. A lead can be trusted to build reports without being
 *    trusted to mail them outside the company.
 *
 * The admin-owned policy (`GET/PUT /policy`) sits on `org:settings` instead: who
 * a report may be sent to is the organization's call, not the report author's,
 * or a lead could widen their own audience.
 *
 * WHAT IS NOT HERE. Nothing in this file sends anything. Publishing marks the run
 * and records the audit event; delivery (email, in-app, Slack/Teams) is the
 * scheduler's, so a publish cannot be held open by a mail server.
 */

import {
  ErrorCode,
  actorId,
  audited,
  recordAudit,
  requirePermission,
  sendBadRequest,
  sendSuccess,
  getParam,
  validateBody,
  parseReportTimezone,
  parseWeekStart,
  type Permission,
} from '@pipeline-builder/api-core';
import { rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import {
  reportingService,
  stakeholderReportStore,
  composeSnapshot,
  getTemplate,
  getSection,
  resolvePeriod,
  resolvePeriodByLabel,
  rejectUnreportablePeriod,
  REPORT_CADENCES,
  REPORT_TEMPLATES,
  MAX_SHARE_LINK_TTL_DAYS,
  DEFAULT_SHARE_LINK_TTL_DAYS,
  type ReportCadence,
  type ReportDefinition,
  type ReportRecipient,
  type ReportRun,
  type ReportShareLink,
  type ReportTemplate,
} from '@pipeline-builder/pipeline-data';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { resolveOrgRollup } from '../helpers/report-helpers.js';
import { resolveOrgRetentionWindow, retentionOrgIdFor } from '../helpers/retention-cap.js';
import { reportIdentity } from '../services/report-identity.js';

/** Section ids a definition may carry. Checked against the live registry. */
const sectionIdSchema = z.string().min(1).max(64).refine((id) => getSection(id) !== undefined, {
  message: 'Unknown report section',
});

const scopeSchema = z.object({
  kind: z.enum(['org', 'projects', 'rollup']),
  projects: z.array(z.string().min(1).max(200)).max(50).optional(),
}).strict().superRefine((scope, ctx) => {
  if (scope.kind === 'projects' && (!scope.projects || scope.projects.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scope.kind "projects" needs at least one project' });
  }
});

const definitionBody = z.object({
  name: z.string().trim().min(1).max(200),
  template: z.enum(REPORT_TEMPLATES),
  /** Omitted ⇒ the template's own section list. */
  sections: z.array(sectionIdSchema).min(1).max(24).optional(),
  cadence: z.enum(REPORT_CADENCES),
  timezone: z.string().min(1).max(64).optional(),
  weekStart: z.enum(['monday', 'sunday']).optional(),
  scope: scopeSchema,
  recipients: z.array(z.string().min(1).max(255)).max(50).optional(),
  autoSend: z.boolean().optional(),
}).strict();

const definitionPatch = definitionBody.partial().extend({
  isActive: z.boolean().optional(),
}).strict();

const transferBody = z.object({
  ownerId: z.string().min(1).max(64),
}).strict();

const notesBody = z.object({
  leadNotes: z.string().max(10_000).optional(),
}).strict();

const runBody = z.object({
  /** A specific period (`2026-W38`), or omitted for the last complete one. */
  period: z.string().min(4).max(20).optional(),
  /** Replace an existing run for this period with version N+1. */
  regenerate: z.boolean().optional(),
}).strict();

const linkBody = z.object({
  ttlDays: z.number().int().min(1).max(MAX_SHARE_LINK_TTL_DAYS).optional(),
  redactNames: z.boolean().optional(),
}).strict();

const recipientBody = z.object({
  email: z.string().trim().min(3).max(320).email(),
  displayName: z.string().trim().max(200).optional(),
}).strict();

const policyBody = z.object({
  externalSharing: z.boolean().optional(),
  recipientDomains: z.array(z.string().trim().min(1).max(253)).max(25).nullable().optional(),
  requireApproval: z.boolean().optional(),
}).strict();

/** The public half of a definition. No internal ids a manager cannot use. */
function definitionView(d: ReportDefinition) {
  return {
    id: d.id,
    name: d.name,
    template: d.template,
    sections: d.sections,
    cadence: d.cadence,
    timezone: d.timezone,
    weekStart: d.weekStart,
    scope: d.scope,
    recipients: d.recipients,
    autoSend: d.autoSend,
    isActive: d.isActive,
    pausedReason: d.pausedReason,
    ownerId: d.ownerId,
    nextRunAt: d.nextRunAt?.toISOString() ?? null,
    lastRunAt: d.lastRunAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function runView(r: ReportRun, opts: { snapshot?: boolean } = {}) {
  return {
    id: r.id,
    definitionId: r.definitionId,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    periodLabel: r.periodLabel,
    version: r.version,
    status: r.status,
    leadNotes: r.leadNotes,
    aiDraft: r.aiDraft,
    failureReason: r.failureReason,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    publishedBy: r.publishedBy,
    supersededBy: r.supersededBy,
    createdAt: r.createdAt.toISOString(),
    ...(opts.snapshot ? { snapshot: r.snapshot } : {}),
  };
}

/** A link, WITHOUT its token — the token existed once, in the mint response. */
function linkView(l: ReportShareLink) {
  return {
    id: l.id,
    runId: l.runId,
    expiresAt: l.expiresAt.toISOString(),
    revokedAt: l.revokedAt?.toISOString() ?? null,
    redactNames: l.redactNames,
    viewCount: l.viewCount,
    lastViewedAt: l.lastViewedAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
  };
}

/**
 * A recipient with its delivery state spelled out. `status` is what the lead
 * needs: a list that shows an address but not that it is unverified is how a
 * report silently reaches nobody.
 */
function recipientView(r: ReportRecipient) {
  const { deliverable, reason } = stakeholderReportStore.deliverability(r);
  return {
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    verified: r.verifiedAt !== null,
    unsubscribed: r.unsubscribedAt !== null,
    bounceCount: r.bounceCount,
    approvedBy: r.approvedBy,
    deliverable,
    ...(reason ? { blockedReason: reason } : {}),
    createdAt: r.createdAt.toISOString(),
  };
}

/** Does the caller hold `permission`? Used where a route needs a second check. */
function holds(req: Request, permission: Permission): boolean {
  const user = req.user as { permissions?: string[]; isSuperAdmin?: boolean } | undefined;
  return user?.isSuperAdmin === true || user?.permissions?.includes(permission) === true;
}

export function createStakeholderReportRoutes(): Router {
  const router = Router();

  // ── Definitions ────────────────────────────────────────────────────────────

  router.get('/definitions', requirePermission('reports:read'), withRoute(async ({ res, ctx, orgId }) => {
    const definitions = await stakeholderReportStore.listDefinitions(orgId);
    ctx.log('COMPLETED', 'Listed report definitions', { count: definitions.length });
    return sendSuccess(res, 200, { definitions: definitions.map(definitionView) });
  }));

  router.post('/definitions', requirePermission('reports:author'), audited('reporting.report.definition.create'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, definitionBody);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const body = validation.value;

    // The shared parsers take a query-shaped bag, so the body field is handed to
    // them under the name they look for — one validator for the report timezone,
    // wherever it arrives from.
    const tz = parseReportTimezone({ tz: body.timezone });
    if (typeof tz !== 'string') return sendBadRequest(res, tz.error, ErrorCode.VALIDATION_ERROR);
    const weekStart = parseWeekStart({ weekStart: body.weekStart });
    if (typeof weekStart !== 'string') return sendBadRequest(res, weekStart.error, ErrorCode.VALIDATION_ERROR);

    const sections = body.sections ?? getTemplate(body.template)?.sections;
    if (!sections || sections.length === 0) {
      return sendBadRequest(res, `Unknown report template "${body.template}"`, ErrorCode.VALIDATION_ERROR);
    }
    const rollupRefused = await refuseUnauthorizedRollup(req, body.scope.kind);
    if (rollupRefused) return sendBadRequest(res, rollupRefused, ErrorCode.INSUFFICIENT_PERMISSIONS);
    const badRecipients = await unknownRecipients(orgId, body.recipients ?? []);
    if (badRecipients) return sendBadRequest(res, badRecipients, ErrorCode.VALIDATION_ERROR);

    const definition = await stakeholderReportStore.createDefinition({
      orgId,
      name: body.name,
      template: body.template as ReportTemplate,
      sections: [...sections],
      cadence: body.cadence as ReportCadence,
      timezone: tz,
      weekStart,
      scope: body.scope,
      recipients: body.recipients ?? [],
      autoSend: body.autoSend ?? false,
      // The CREATOR owns it. A scheduled run is authorized as the owner, so
      // accepting an ownerId here would let anyone with `reports:author` schedule
      // a report that runs with someone else's access.
      ownerId: userId,
      createdBy: userId,
    });
    ctx.log('COMPLETED', 'Created report definition', { definitionId: definition.id, template: definition.template });
    recordAudit({
      action: 'reporting.report.definition.create',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-definition',
      targetId: definition.id,
      details: {
        name: definition.name,
        template: definition.template,
        cadence: definition.cadence,
        sections: definition.sections.length,
        autoSend: definition.autoSend,
        recipients: definition.recipients.length,
      },
    });
    return sendSuccess(res, 201, { definition: definitionView(definition) });
  }));

  router.get('/definitions/:id', requirePermission('reports:read'), withRoute(async ({ req, res, orgId }) => {
    const definition = await stakeholderReportStore.requireDefinition(orgId, getParam(req.params, 'id') ?? '');
    return sendSuccess(res, 200, { definition: definitionView(definition) });
  }));

  router.put('/definitions/:id', requirePermission('reports:author'), audited('reporting.report.definition.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const validation = validateBody(req, definitionPatch);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const body = validation.value;
    await stakeholderReportStore.requireDefinition(orgId, id);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.cadence !== undefined) patch.cadence = body.cadence;
    if (body.autoSend !== undefined) patch.autoSend = body.autoSend;
    if (body.scope !== undefined) {
      const rollupRefused = await refuseUnauthorizedRollup(req, body.scope.kind);
      if (rollupRefused) return sendBadRequest(res, rollupRefused, ErrorCode.INSUFFICIENT_PERMISSIONS);
      patch.scope = body.scope;
    }
    if (body.recipients !== undefined) {
      const badRecipients = await unknownRecipients(orgId, body.recipients);
      if (badRecipients) return sendBadRequest(res, badRecipients, ErrorCode.VALIDATION_ERROR);
      patch.recipients = body.recipients;
    }
    if (body.timezone !== undefined) {
      const tz = parseReportTimezone({ tz: body.timezone });
      if (typeof tz !== 'string') return sendBadRequest(res, tz.error, ErrorCode.VALIDATION_ERROR);
      patch.timezone = tz;
    }
    if (body.weekStart !== undefined) {
      const weekStart = parseWeekStart({ weekStart: body.weekStart });
      if (typeof weekStart !== 'string') return sendBadRequest(res, weekStart.error, ErrorCode.VALIDATION_ERROR);
      patch.weekStart = weekStart;
    }
    if (body.template !== undefined) {
      patch.template = body.template;
      // Changing the template resets the section list unless the caller named one
      // — otherwise a "monthly health" report would keep the weekly sections and
      // the template name would be a lie.
      patch.sections = [...(body.sections ?? getTemplate(body.template)?.sections ?? [])];
    } else if (body.sections !== undefined) {
      patch.sections = [...body.sections];
    }
    if (body.isActive !== undefined) {
      patch.isActive = body.isActive;
      // Resuming clears the pause reason; the scheduler re-checks and re-pauses if
      // the cause is still there, so this cannot resurrect a lapsed entitlement.
      if (body.isActive) patch.pausedReason = null;
    }

    const definition = await stakeholderReportStore.updateDefinition(orgId, id, patch, userId);
    ctx.log('COMPLETED', 'Updated report definition', { definitionId: id, fields: Object.keys(patch) });
    recordAudit({
      action: 'reporting.report.definition.update',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-definition',
      targetId: id,
      details: { fields: Object.keys(patch).sort(), name: definition.name },
    });
    return sendSuccess(res, 200, { definition: definitionView(definition) });
  }));

  router.delete('/definitions/:id', requirePermission('reports:author'), audited('reporting.report.definition.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const definition = await stakeholderReportStore.requireDefinition(orgId, id);
    await stakeholderReportStore.deleteDefinition(orgId, id, userId);
    ctx.log('COMPLETED', 'Deleted report definition', { definitionId: id });
    recordAudit({
      action: 'reporting.report.definition.delete',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-definition',
      targetId: id,
      // The live share links went with it: a deleted report whose public URL still
      // serves last month's numbers is the gap nobody notices until it matters.
      details: { name: definition.name, shareLinksRevoked: true },
    });
    return sendSuccess(res, 200, { deleted: true });
  }));

  /**
   * Hand a definition to a new owner.
   *
   * A privilege move, not a metadata edit: a scheduled run is authorized as the
   * OWNER, so this changes whose access the numbers are computed with. The new
   * owner must be an active member who holds `reports:author` — checked against
   * platform, not inferred — so a definition cannot be parked on an account that
   * would never pass the scheduler's own re-check.
   */
  router.post('/definitions/:id/transfer', requirePermission('reports:author'), audited('reporting.report.ownership.transfer'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const validation = validateBody(req, transferBody);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const newOwnerId = validation.value.ownerId;
    const previous = await stakeholderReportStore.requireDefinition(orgId, id);

    const authority = await reportIdentity().authority(orgId, newOwnerId);
    // Fail closed on a null: an unreachable platform must not be a way to park a
    // definition on an unverified owner.
    if (!authority?.active || !authority.permissions.includes('reports:author')) {
      return sendBadRequest(
        res,
        'That user cannot own a report in this organization — they need to be an active member with permission to author reports.',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const definition = await stakeholderReportStore.transferOwner(orgId, id, newOwnerId, userId);
    ctx.log('COMPLETED', 'Transferred report ownership', { definitionId: id });
    recordAudit({
      action: 'reporting.report.ownership.transfer',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-definition',
      targetId: id,
      details: { name: definition.name, previousOwnerId: previous.ownerId, newOwnerId },
    });
    return sendSuccess(res, 200, { definition: definitionView(definition) });
  }));

  // ── Runs ───────────────────────────────────────────────────────────────────

  router.get('/definitions/:id/runs', requirePermission('reports:read'), withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id') ?? '';
    await stakeholderReportStore.requireDefinition(orgId, id);
    const runs = await stakeholderReportStore.listRuns(orgId, id);
    return sendSuccess(res, 200, { runs: runs.map((r) => runView(r)) });
  }));

  /**
   * Compute a run now.
   *
   * Composing is the expensive path in this file — one query per section, twice
   * (this period and the one before) — so it is rate-limited per org: a lead
   * clicking "regenerate" repeatedly must not be able to saturate the reporting
   * database for everyone else in their organization.
   */
  router.post('/definitions/:id/runs',
    requirePermission('reports:author'),
    rateLimitByOrg({ name: 'report-compose', max: 20, windowMs: 60_000, message: 'Too many report generations — wait a moment before generating another.' }),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const id = getParam(req.params, 'id') ?? '';
      const validation = validateBody(req, runBody);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { period: label, regenerate } = validation.value;
      const definition = await stakeholderReportStore.requireDefinition(orgId, id);
      // The grant could have been withdrawn since the definition was saved. A
      // narrowed report is the WRONG answer — it would still be labelled as
      // covering the teams — so the run is refused with the reason instead.
      const rollupRefused = await refuseUnauthorizedRollup(req, definition.scope.kind);
      if (rollupRefused) return sendBadRequest(res, rollupRefused, ErrorCode.INSUFFICIENT_PERMISSIONS);

      const period = label
        ? resolvePeriodByLabel(label, definition.cadence, definition.timezone, definition.weekStart as 'monday' | 'sunday')
        : resolvePeriod(definition.cadence, definition.timezone, definition.weekStart as 'monday' | 'sunday');
      if (!period) {
        return sendBadRequest(
          res,
          `"${label}" is not a ${definition.cadence} period label. Use 2026-W38 for weekly, 2026-08 for monthly, 2026-Q3 for quarterly.`,
          ErrorCode.VALIDATION_ERROR,
        );
      }

      // A period the data cannot support is REFUSED with the reason, never
      // silently truncated: a report labelled 2026-Q1 that quietly covers only its
      // last 30 days is worse than no report, because nobody can tell.
      const { minFromMs } = await resolveOrgRetentionWindow(orgId, 'event', retentionOrgIdFor(req, orgId));
      const rejection = rejectUnreportablePeriod(period, { minFromMs, includePrevious: true });
      if (rejection) return sendBadRequest(res, rejection.message, ErrorCode.VALIDATION_ERROR);

      const version = regenerate ? await stakeholderReportStore.nextVersion(id, period.start) : 1;
      const { run, created } = await stakeholderReportStore.createRun({
        orgId,
        definitionId: id,
        periodStart: period.start,
        periodEnd: period.end,
        periodLabel: period.label,
        version,
      });
      if (!created && !regenerate && run.snapshot) {
        // The period already has a run and the caller did not ask for a new
        // version. Hand back what exists rather than recomputing it — the numbers
        // in a frozen snapshot do not change.
        return sendSuccess(res, 200, { run: runView(run, { snapshot: true }), reused: true });
      }

      const features = (req.user as { features?: string[] } | undefined)?.features ?? [];
      try {
        const snapshot = await composeSnapshot(definition.sections, {
          source: reportingService,
          period,
          timezone: definition.timezone,
          weekStart: definition.weekStart as 'monday' | 'sunday',
          orgId,
          // `resolveOrgRollup` is called directly rather than through the
          // request-driven `rollupIds`: the scope lives on the DEFINITION, not in a
          // query parameter. The caller's permission was re-checked above.
          ...(definition.scope.kind === 'rollup' ? { orgIds: await resolveOrgRollup(orgId) } : {}),
          features,
        });
        const completed = await stakeholderReportStore.completeRun(orgId, run.id, snapshot as unknown as Record<string, unknown>);
        if (version > 1) {
          const prior = (await stakeholderReportStore.listRuns(orgId, id))
            .find((r) => r.periodLabel === period.label && r.version === version - 1);
          if (prior) await stakeholderReportStore.supersede(orgId, prior.id, completed.id);
        }
        ctx.log('COMPLETED', 'Composed report run', { runId: completed.id, period: period.label, version });
        return sendSuccess(res, 201, { run: runView(completed, { snapshot: true }) });
      } catch (err) {
        // The run row stays, marked failed with the reason, so the lead sees WHY a
        // report is missing instead of an empty history.
        await stakeholderReportStore.failRun(orgId, run.id, 'The report could not be computed for this period.');
        throw err;
      }
    }));

  router.get('/runs/:id', requirePermission('reports:read'), withRoute(async ({ req, res, orgId }) => {
    const run = await stakeholderReportStore.requireRun(orgId, getParam(req.params, 'id') ?? '');
    return sendSuccess(res, 200, { run: runView(run, { snapshot: true }) });
  }));

  /**
   * The lead's own words on a run that has not been published.
   *
   * Refused after publish (the store enforces it): the notes are part of what the
   * recipients read, and a narrative that can be edited after delivery makes the
   * delivered version unreconstructable. Regenerating produces version N+1, which
   * is the supported way to correct a published report.
   */
  router.put('/runs/:id/notes', requirePermission('reports:author'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const validation = validateBody(req, notesBody);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const run = await stakeholderReportStore.setRunNotes(orgId, id, validation.value);
    ctx.log('COMPLETED', 'Updated report notes', { runId: id });
    return sendSuccess(res, 200, { run: runView(run) });
  }));

  /**
   * Publish a run.
   *
   * The response says plainly that a delivered copy cannot be recalled. Revoking a
   * link later pulls back the URL, not the email that already arrived, and a lead
   * who learns that after publishing learns it too late.
   */
  router.post('/runs/:id/publish', requirePermission('reports:share'), audited('reporting.report.published', 'reporting.report.republished'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const { run, alreadyPublished } = await stakeholderReportStore.publishRun(orgId, id, userId);
    const recipients = await stakeholderReportStore.getRecipients(orgId, await definitionRecipients(orgId, run.definitionId));
    const deliverable = recipients.filter((r) => stakeholderReportStore.deliverability(r).deliverable);

    if (!alreadyPublished) {
      recordAudit({
        // A second version of a period that was already published is a
        // CORRECTION, and it reads differently in an audit trail from a first
        // publish — someone reviewing the report's history needs to see that the
        // numbers a manager acted on were superseded.
        action: run.version > 1 ? 'reporting.report.republished' : 'reporting.report.published',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'report-run',
        targetId: run.id,
        details: {
          definitionId: run.definitionId,
          period: run.periodLabel,
          version: run.version,
          recipients: deliverable.length,
          pendingRecipients: recipients.length - deliverable.length,
        },
      });
    }
    ctx.log('COMPLETED', 'Published report run', { runId: id, version: run.version, alreadyPublished });
    return sendSuccess(res, 200, {
      run: runView(run),
      recipients: { deliverable: deliverable.length, blocked: recipients.length - deliverable.length },
      alreadyPublished,
      notice: 'Delivered copies cannot be recalled. Revoking a share link stops new views of the link; '
        + 'it does not pull back an email that has already arrived.',
    });
  }));

  // ── Share links ────────────────────────────────────────────────────────────

  router.get('/runs/:id/links', requirePermission('reports:read'), withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id') ?? '';
    await stakeholderReportStore.requireRun(orgId, id);
    const links = await stakeholderReportStore.listShareLinks(orgId, id);
    return sendSuccess(res, 200, { links: links.map(linkView) });
  }));

  /**
   * Mint a read-only public link.
   *
   * Gated TWICE, and both gates are load-bearing: `reports:share` is the lead's
   * permission, and the org's `externalSharing` policy is the ADMIN's decision
   * that public links are allowed here at all. It defaults off, so an org that has
   * configured nothing cannot have a report URL minted by someone who assumed
   * their permission was the whole answer.
   *
   * The token is in this response and nowhere else. Only its hash is stored.
   */
  router.post('/runs/:id/links', requirePermission('reports:share'), audited('reporting.report.link.created'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const validation = validateBody(req, linkBody);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

    const policy = await stakeholderReportStore.getReportPolicy(orgId);
    if (!policy.externalSharing) {
      return sendBadRequest(
        res,
        'Public share links are turned off for this organization. An administrator can enable them in reporting settings.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    const { link, token } = await stakeholderReportStore.createShareLink({
      orgId,
      runId: id,
      createdBy: userId,
      ...(validation.value.ttlDays !== undefined ? { ttlDays: validation.value.ttlDays } : {}),
      ...(validation.value.redactNames !== undefined ? { redactNames: validation.value.redactNames } : {}),
    });
    ctx.log('COMPLETED', 'Created report share link', { runId: id, linkId: link.id, ttlDays: validation.value.ttlDays ?? DEFAULT_SHARE_LINK_TTL_DAYS });
    recordAudit({
      action: 'reporting.report.link.created',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-share-link',
      targetId: link.id,
      // The token is NOT in the audit details. An audit row that carries a working
      // credential turns read access to the trail into read access to the report.
      details: { runId: id, expiresAt: link.expiresAt.toISOString(), redactNames: link.redactNames },
    });
    return sendSuccess(res, 201, {
      link: linkView(link),
      token,
      notice: 'This link is shown once — anyone who has it can read the report until it expires or is revoked. '
        + 'Revoking it does not pull back a copy someone already downloaded.',
    });
  }));

  router.delete('/links/:id', requirePermission('reports:share'), audited('reporting.report.link.revoked'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const link = await stakeholderReportStore.revokeShareLink(orgId, id, userId);
    ctx.log('COMPLETED', 'Revoked report share link', { linkId: id, runId: link.runId });
    recordAudit({
      action: 'reporting.report.link.revoked',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-share-link',
      targetId: id,
      details: { runId: link.runId, viewCount: link.viewCount },
    });
    return sendSuccess(res, 200, { link: linkView(link) });
  }));

  // ── Recipients ─────────────────────────────────────────────────────────────

  router.get('/recipients', requirePermission('reports:read'), withRoute(async ({ res, orgId }) => {
    const recipients = await stakeholderReportStore.listRecipients(orgId);
    return sendSuccess(res, 200, { recipients: recipients.map(recipientView) });
  }));

  /**
   * Add a delivery address.
   *
   * Three checks, in this order, and each one exists because of a different way
   * this route could leak an org's delivery numbers:
   *
   *  1. IS IT A MEMBER? A member address is always admissible and skips
   *     verification — the org already established that person belongs to it.
   *  2. IS THE DOMAIN ALLOWED? Anything else is measured against the admin's
   *     allowed-domain list, and an empty list means "members only", not "anyone".
   *  3. DOES IT NEED APPROVAL? When the org requires it, an external address is
   *     stored UNAPPROVED and nothing is delivered to it until an admin approves.
   *
   * An external address also has to confirm by email before the first delivery
   * (the store mints the token here), so typing an address is never enough to make
   * a report arrive at it.
   */
  router.post('/recipients',
    requirePermission('reports:author'),
    rateLimitByOrg({ name: 'report-recipient-add', max: 30, windowMs: 60 * 60_000, message: 'Too many recipient additions — try again later.' }),
    audited('reporting.report.recipient.added'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, recipientBody);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { email, displayName } = validation.value;

      const policy = await stakeholderReportStore.getReportPolicy(orgId);
      const check = await reportIdentity().recipientCheck(orgId, email);
      // A null (platform unreachable) is treated as "not a member", so the address
      // falls through to the domain policy rather than skipping verification.
      const memberEmails = new Set(check?.member ? [email.trim().toLowerCase()] : []);
      const admission = stakeholderReportStore.admitRecipient(email, policy, memberEmails);
      if (!admission.admitted) {
        return sendBadRequest(res, admission.reason, ErrorCode.VALIDATION_ERROR);
      }

      // An approver's own addition counts as the approval — requiring an admin to
      // approve the address they just typed is ceremony, not control.
      const selfApproved = admission.needsApproval && holds(req, 'org:settings');
      const { recipient, verificationToken } = await stakeholderReportStore.upsertRecipient({
        orgId,
        email,
        ...(displayName ? { displayName } : {}),
        createdBy: userId,
        preVerified: admission.member,
        approvedBy: admission.needsApproval ? (selfApproved ? userId : null) : userId,
      });

      const pendingApproval = admission.needsApproval && !selfApproved;
      ctx.log('COMPLETED', 'Added report recipient', {
        recipientId: recipient.id,
        member: admission.member,
        pendingApproval,
        pendingVerification: verificationToken !== undefined,
      });
      recordAudit({
        action: 'reporting.report.recipient.added',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'report-recipient',
        targetId: recipient.id,
        // The address IS the point of this event — who org data may be sent to is
        // exactly what a reviewer is looking for — but the verification token
        // never appears.
        details: {
          email: recipient.email,
          member: admission.member,
          pendingApproval,
          pendingVerification: verificationToken !== undefined,
        },
      });
      return sendSuccess(res, 201, {
        recipient: recipientView(recipient),
        pendingApproval,
        // The token goes to the CALLER, which is how the service that owns mail
        // delivery sends the confirmation. Phase 5 hands it to the mailer; until
        // then a lead can resend, and nothing is delivered unverified either way.
        ...(verificationToken ? { verificationToken } : {}),
      });
    }));

  /** Re-mint a pending recipient's confirmation token, so a lost email is recoverable. */
  router.post('/recipients/:id/resend',
    requirePermission('reports:author'),
    rateLimitByOrg({ name: 'report-recipient-resend', max: 10, windowMs: 60 * 60_000, message: 'Too many verification resends — try again later.' }),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const id = getParam(req.params, 'id') ?? '';
      const { recipient, token } = await stakeholderReportStore.resendVerification(orgId, id);
      ctx.log('COMPLETED', 'Resent recipient verification', { recipientId: id });
      return sendSuccess(res, 200, { recipient: recipientView(recipient), verificationToken: token });
    }));

  router.delete('/recipients/:id', requirePermission('reports:author'), audited('reporting.report.recipient.removed'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const recipients = await stakeholderReportStore.getRecipients(orgId, [id]);
    await stakeholderReportStore.deleteRecipient(orgId, id, userId);
    ctx.log('COMPLETED', 'Removed report recipient', { recipientId: id });
    recordAudit({
      action: 'reporting.report.recipient.removed',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-recipient',
      targetId: id,
      details: { email: recipients[0]?.email ?? null },
    });
    return sendSuccess(res, 200, { deleted: true });
  }));

  // ── Org policy (admin) ─────────────────────────────────────────────────────

  router.get('/policy', requirePermission('reports:read'), withRoute(async ({ res, orgId }) => {
    return sendSuccess(res, 200, { policy: await stakeholderReportStore.getReportPolicy(orgId) });
  }));

  /**
   * The admin's decision about who reports may reach. `org:settings`, not
   * `reports:author`: a lead must not be able to widen their own audience.
   */
  router.put('/policy', requirePermission('org:settings'), audited('reporting.report.policy.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, policyBody);
    if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    const patch = validation.value;
    const domains = patch.recipientDomains
      ? [...new Set(patch.recipientDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))]
      : patch.recipientDomains;
    await stakeholderReportStore.setReportPolicy(orgId, {
      ...(patch.externalSharing !== undefined ? { externalSharing: patch.externalSharing } : {}),
      ...(domains !== undefined ? { recipientDomains: domains } : {}),
      ...(patch.requireApproval !== undefined ? { requireApproval: patch.requireApproval } : {}),
    });
    const policy = await stakeholderReportStore.getReportPolicy(orgId);
    ctx.log('COMPLETED', 'Updated report policy', { orgId, fields: Object.keys(patch) });
    recordAudit({
      action: 'reporting.report.policy.update',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'report-policy',
      targetId: orgId,
      details: { ...policy },
    });
    return sendSuccess(res, 200, { policy });
  }));

  return router;
}

/**
 * A rollup scope reads DESCENDANT teams' data, which is a separate grant
 * (`reports:rollup`) from reading your own org's. Refused at save time rather than
 * at run time so a lead cannot store a definition whose every run would be
 * silently narrowed — a report that quietly stopped including the teams it says it
 * covers is a wrong report, not a degraded one.
 */
async function refuseUnauthorizedRollup(req: Request, kind: string): Promise<string | null> {
  if (kind !== 'rollup') return null;
  if (holds(req, 'reports:rollup')) return null;
  return 'A rollup report includes your descendant teams, which needs the "Roll up team reports" permission.';
}

/** Recipient ids that are not live rows in this org, as a ready error message. */
async function unknownRecipients(orgId: string, ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const found = await stakeholderReportStore.getRecipients(orgId, ids);
  const known = new Set(found.map((r) => r.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length === 0) return null;
  return `Unknown recipient${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Add the address first.`;
}

/** The recipient ids a definition names, for the publish summary. */
async function definitionRecipients(orgId: string, definitionId: string): Promise<string[]> {
  const definition = await stakeholderReportStore.getDefinition(orgId, definitionId);
  return definition?.recipients ?? [];
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  actorId,
  assertSafeUrl,
  audited,
  ErrorCode,
  getParam,
  recordAudit,
  requireAuth,
  requireInternalService,
  requirePermission,
  sendBadRequest,
  sendSuccess,
  validateBody,
  validateQuery,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { resolveRootOrgId } from '../helpers/org-hierarchy.js';
import { periodDaysFor } from '../helpers/quota-helpers.js';
import { authorizeOrg } from '../middleware/authorize-org.js';
import { QUOTA_NOTICE_THRESHOLDS, QuotaNoticeSettings, type QuotaNoticeSettingsDocument } from '../models/quota-notice.js';
import { invalidateAiControls } from '../services/ai-controls.js';
import { type QuotaService, quotaService as defaultQuotaService } from '../services/quota-service.js';
import { queryUsage, usageToCsv } from '../services/usage-ledger.js';
import { NoticeSettingsSchema, USAGE_MAX_RANGE_DAYS, UsageQuerySchema } from '../validation/schemas.js';

const DAY_MS = 86_400_000;

/**
 * The account's quota settings as both notice-settings routes answer them. One
 * builder so the read and the write report the same shape: the PUT used to
 * spell the object out a second time and had already lost
 * `noticesEnabledOnInstance`, and both hard-coded the thresholds the notifier
 * reads from `QUOTA_NOTICE_THRESHOLDS`.
 */
function noticeSettingsView(orgId: string, row: Partial<QuotaNoticeSettingsDocument> | null | undefined) {
  return {
    orgId,
    enabled: row?.enabled ?? true,
    // Stored `null` means the account never said, which reads as ON — the
    // switch is an opt-OUT (D6). `!== false` rather than `?? true` so a
    // stored `false` survives.
    offersEnabled: row?.offersEnabled !== false,
    webhookUrl: row?.webhookUrl ?? null,
    thresholds: [...QUOTA_NOTICE_THRESHOLDS],
    // Deploy-wide switch: when off, no account gets notices regardless.
    noticesEnabledOnInstance: config.quota.thresholdNoticesEnabled,
    // Optional AI controls (services/ai-controls.ts): null = off.
    aiCallsPerMemberPct: row?.aiCallsPerMemberPct ?? null,
    aiTokenBudget: row?.aiTokenBudget ?? null,
  };
}

/**
 * Usage attribution + notice routes, all `/:orgId/<literal>`.
 *
 * Mounted BEFORE the read router (see app-routes.ts): its `/:orgId/:quotaType`
 * pattern would otherwise claim `GET /:orgId/usage` and answer "invalid quota
 * type".
 */
export function createUsageRoutes(svc: QuotaService = defaultQuotaService): Router {
  const router: Router = Router();

  // GET /quotas/:orgId/usage — "what used this quota".
  //
  // Groups the usage ledger by principal | route | pipeline | day | feature |
  // model (AI calls: product surface; model × key source) over a time
  // range (default: the requested type's period length back from now — a
  // month for `cpuCredits`, the global window otherwise), optionally for
  // one quota type; `format=csv` downloads the same rows. Scope follows
  // pooling: a pool root (or a flat org) sees its whole account, a team sees
  // only its own events (see `queryUsage`). Tenancy via `authorizeOrg()`.
  router.get(
    '/:orgId/usage',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    requirePermission('quotas:read') as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const orgId = getParam(req.params, 'orgId')!;
      const parsed = validateQuery(req, UsageQuerySchema);
      if (!parsed.ok) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);
      const q = parsed.value;

      const to = q.to ? new Date(q.to) : new Date();
      // The TYPE's period: `cpuCredits` is monthly, so the global three-day
      // default showed a tenth of its period and read as "barely used".
      const periodDays = q.type ? periodDaysFor(q.type) : config.quota.resetDays;
      const from = q.from ? new Date(q.from) : new Date(to.getTime() - periodDays * DAY_MS);
      if (from >= to) return sendBadRequest(res, '`from` must be before `to`.', ErrorCode.VALIDATION_ERROR);
      if (to.getTime() - from.getTime() > USAGE_MAX_RANGE_DAYS * DAY_MS) {
        return sendBadRequest(res, `The range may span at most ${USAGE_MAX_RANGE_DAYS} days.`, ErrorCode.VALIDATION_ERROR);
      }

      const groups = await queryUsage({ orgId, quotaType: q.type, from, to, groupBy: q.groupBy });
      ctx.log('COMPLETED', 'Read quota usage breakdown', { orgId, groupBy: q.groupBy, type: q.type, groups: groups.length });

      if (q.format === 'csv') {
        const name = `quota-usage-${q.type ?? 'all'}-by-${q.groupBy}-${from.toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        // Sent raw, not through sendSuccess: the caller asked for a file.
        res.status(200).send(usageToCsv(q.groupBy, groups));
        return undefined;
      }
      return sendSuccess(res, 200, {
        orgId,
        type: q.type ?? null,
        groupBy: q.groupBy,
        from: from.toISOString(),
        to: to.toISOString(),
        retentionDays: config.quota.usageEventRetentionDays,
        groups,
      });
    }),
  );

  // GET /quotas/:orgId/own-usage — the org's OWN numbers, no pooling.
  //
  // Internal (billing's per-team usage breakdown). `GET /quotas/:orgId`
  // reports the POOL for every member of a pool, so reading it per team showed
  // the account total on every row. Service-only: a team's own limits are -1 by
  // design, and showing them to a person would read as "unlimited".
  router.get(
    '/:orgId/own-usage',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    requireInternalService({ callers: ['billing'] }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const orgId = getParam(req.params, 'orgId')!;
      const quota = await svc.findOwnByOrgId(orgId);
      ctx.log('COMPLETED', 'Retrieved own (unpooled) org quotas', { orgId });
      return sendSuccess(res, 200, { quota });
    }),
  );

  // GET /quotas/:orgId/notice-settings — the account's quota settings: the
  // threshold notices and the optional AI controls (a team reads its root's:
  // both are per account).
  router.get(
    '/:orgId/notice-settings',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    requirePermission('quotas:read') as RequestHandler,
    withRoute(async ({ req, res }) => {
      const orgId = getParam(req.params, 'orgId')!;
      const rootOrgId = await resolveRootOrgId(orgId);
      const row = await QuotaNoticeSettings.findOne({ orgId: rootOrgId }).lean();
      return sendSuccess(res, 200, { settings: noticeSettingsView(rootOrgId, row) });
    }),
  );

  // PUT /quotas/:orgId/notice-settings — opt out of / back into the 80% and
  // 100% notices, opt out of / back into expansion OFFERS on the same channel
  // (`offersEnabled`, D6: default on, and ANDed with `enabled` at send time, so
  // silencing notices silences offers too), set the `quota.threshold` webhook,
  // and set or clear (`null`) the optional AI controls: `aiCallsPerMemberPct` (per-member share of the
  // account's aiCalls) and `aiTokenBudget` (per-period platform-key tokens).
  // Billing contacts (`billing:manage`) own it, on the account ROOT only — a
  // team admin must not silence the whole account's warnings or re-carve its
  // AI budget.
  router.put(
    '/:orgId/notice-settings',
    requireAuth as RequestHandler,
    authorizeOrg() as RequestHandler,
    requirePermission('billing:manage') as RequestHandler,
    audited('quota.notice_settings.update'),
    withRoute(async ({ req, res, ctx, userId }) => {
      const orgId = getParam(req.params, 'orgId')!;
      const validation = validateBody(req, NoticeSettingsSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const body = validation.value;

      if ((await resolveRootOrgId(orgId)) !== orgId) {
        return sendBadRequest(res, 'Quota notices are set on the root organization (the account), not on a team.', ErrorCode.VALIDATION_ERROR);
      }
      if (body.webhookUrl) {
        try {
          await assertSafeUrl(body.webhookUrl);
        } catch {
          return sendBadRequest(res, 'webhookUrl must resolve to a public address.', ErrorCode.VALIDATION_ERROR);
        }
      }

      const row = await QuotaNoticeSettings.findOneAndUpdate(
        { orgId },
        {
          $set: {
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.offersEnabled !== undefined ? { offersEnabled: body.offersEnabled } : {}),
            ...(body.webhookUrl !== undefined ? { webhookUrl: body.webhookUrl } : {}),
            ...(body.aiCallsPerMemberPct !== undefined ? { aiCallsPerMemberPct: body.aiCallsPerMemberPct } : {}),
            ...(body.aiTokenBudget !== undefined ? { aiTokenBudget: body.aiTokenBudget } : {}),
            updatedAt: new Date(),
            updatedBy: userId,
          },
        },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      invalidateAiControls(orgId);
      ctx.log('COMPLETED', 'Updated quota notice settings', { orgId });

      recordAudit({
        action: 'quota.notice_settings.update',
        actorId: actorId({ userId }),
        // A tenant's billing contact acting on its own account.
        orgId,
        details: {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          // Recorded because it is a CONSENT change: "when did this account turn
          // offers off" has to be answerable from the trail, not inferred from
          // the absence of offers afterwards.
          ...(body.offersEnabled !== undefined ? { offersEnabled: body.offersEnabled } : {}),
          // Whether a webhook is configured — never the URL (it can embed a token).
          ...(body.webhookUrl !== undefined ? { webhookConfigured: body.webhookUrl !== null } : {}),
          ...(body.aiCallsPerMemberPct !== undefined ? { aiCallsPerMemberPct: body.aiCallsPerMemberPct } : {}),
          ...(body.aiTokenBudget !== undefined ? { aiTokenBudget: body.aiTokenBudget } : {}),
        },
      });

      return sendSuccess(res, 200, { settings: noticeSettingsView(orgId, row) }, 'Notice settings updated');
    }),
  );

  return router;
}

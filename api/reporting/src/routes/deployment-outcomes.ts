// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, ErrorCode, validateBody, audited } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { z } from 'zod';
import { orgRetentionWindowFromSettings } from '../helpers/retention-cap.js';
import { emitReportingAudit } from '../services/audit.js';

/**
 * Post-deploy outcome markers (Phase 2). A user marks a deployment `failed`
 * (a production incident linked to the deploy) or `restored` (recovered). These
 * feed the DORA post-deploy Change Failure Rate component and the real MTTR.
 *
 * The write is org-scoped (RLS via the caller's org context) and idempotent —
 * re-posting the same (execution, outcome) refreshes `at` instead of
 * double-counting. Mounted `advanced_reporting`-gated alongside the other DORA
 * routes (see index.ts).
 *
 * ANTI-FORGERY (api#5): the DORA compute makes a `failed` outcome's `environment`
 * appear as its own env card even with zero real deploys, so an unvalidated write
 * could manufacture PHANTOM environments (fake CFR/MTTR). Two guards close that:
 *   1. `at` must fall within `[now − effectiveDoraRetention, now]` — no future or
 *      pre-retention markers that would land outside every readable report window.
 *   2. a supplied `environment` must be a REAL deploy environment observed for the
 *      org within the retention window (pipeline-data has no execution-id resolver
 *      to key on, so the env — the sole lever that surfaces a phantom card — is the
 *      validated dimension). An omitted environment is null-scoped and is dropped
 *      by the CFR/MTTR compute, so it needs no check.
 */
const outcomeSchema = z.object({
  outcome: z.enum(['failed', 'restored']),
  // When the deploy failed / was restored (ISO 8601, offset required).
  at: z.string().datetime({ offset: true }),
  // Deploy target (e.g. "production"). Optional; defaults to the deploy's env.
  environment: z.string().max(255).optional(),
});

/** Tolerance for a client clock running slightly ahead of the server (1 min). */
const CLOCK_SKEW_MS = 60_000;

export function createDeploymentOutcomeRoutes(): Router {
  const router = Router();

  router.post('/:executionId/outcome', audited('reporting.deployment.outcome'), withRoute(async ({ req, res, orgId, userId }) => {
    const executionId = typeof req.params.executionId === 'string' ? req.params.executionId : '';
    if (!executionId) return sendBadRequest(res, 'executionId is required', ErrorCode.VALIDATION_ERROR);

    const parsed = validateBody(req, outcomeSchema);
    if (!parsed.ok) return sendBadRequest(res, parsed.error, ErrorCode.VALIDATION_ERROR);

    // Bound `at` to the readable DORA horizon so a marker can't be planted in the
    // future or before the org's retention (where no report would ever surface it,
    // yet a mid-window purge could strand it). Unlimited retention ⇒ minFromMs=0.
    const now = Date.now();
    const settings = await reportingService.getIncidentSettings(orgId);
    const win = orgRetentionWindowFromSettings(settings, 'dora', now);
    const atMs = Date.parse(parsed.value.at);
    if (atMs > now + CLOCK_SKEW_MS) {
      return sendBadRequest(res, '`at` cannot be in the future', ErrorCode.VALIDATION_ERROR);
    }
    if (win.minFromMs > 0 && atMs < win.minFromMs) {
      return sendBadRequest(res, '`at` is older than the DORA retention window', ErrorCode.VALIDATION_ERROR);
    }

    // A supplied environment must be one the org has actually deployed to in the
    // retention window — otherwise the failed-outcome would mint a phantom env card.
    if (parsed.value.environment) {
      const fromMs = win.minFromMs > 0 ? win.minFromMs : now - win.maxRangeMs;
      const environments = await reportingService.getReportEnvironments(
        orgId, new Date(fromMs).toISOString(), new Date(now).toISOString(), [orgId],
      );
      if (!environments.includes(parsed.value.environment)) {
        return sendBadRequest(
          res,
          `Unknown deploy environment "${parsed.value.environment}" — no deploy to it in the retention window`,
          ErrorCode.VALIDATION_ERROR,
        );
      }
    }

    await reportingService.recordDeploymentOutcome(orgId, executionId, parsed.value);
    // Best-effort attributed audit — a `failed`/`restored` marker rewrites the
    // org's reported change-failure rate + MTTR (the DORA numbers a customer may
    // report externally), so who marked what, when, needs a durable trail.
    // Emitted only after the idempotent upsert landed.
    emitReportingAudit({
      action: 'reporting.deployment.outcome',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'deployment',
      targetId: executionId,
      details: {
        outcome: parsed.value.outcome,
        at: parsed.value.at,
        ...(parsed.value.environment !== undefined ? { environment: parsed.value.environment } : {}),
      },
    });
    sendSuccess(res, 200, { executionId, outcome: parsed.value.outcome });
  }));

  return router;
}

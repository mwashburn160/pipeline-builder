// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The free preview: one watermarked stakeholder report, once, for an org that has not
 * bought the add-on.
 *
 * ITS OWN ROUTER, mounted OUTSIDE `requireFeature('stakeholder_reports')`, because the
 * whole point is to be reachable by someone who does not hold the feature. Everything
 * else about the add-on stays behind that gate.
 *
 * WHAT MAKES IT UNSCHEDULABLE AND UNSHAREABLE IS THAT NOTHING IS PERSISTED. The plan
 * requires a preview that "can't be scheduled or shared"; the obvious implementation —
 * store a run and mark it `preview` — leaves both properties depending on every future
 * caller checking the flag. Composing and returning the snapshot inline means there is
 * no definition to schedule and no run id to mint a share link against. The constraint
 * is structural rather than remembered.
 *
 * IT IS COMPOSED AS IF ENTITLED, including the DORA panels. A sample report with its
 * headline numbers locked behind a second purchase would be a worse advertisement than
 * no sample at all — and it would not show the lead the thing they are deciding about.
 * The honesty lives in the watermark and the copy, not in withholding panels, and the
 * exposure is bounded by "once, ever, per org".
 *
 * ONCE IS ENFORCED BY A CONDITIONAL WRITE, not a read-then-write: see
 * `claimReportPreview`. Two tabs clicking at the same moment produce one preview.
 */

import {
  createLogger,
  emitCounter,
  ErrorCode,
  errorMessage,
  isBillingEnabled,
  requirePermission,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import {
  composeSnapshot,
  getTemplate,
  resolvePeriod,
  stakeholderReportStore,
  type ReportSnapshot,
} from '@pipeline-builder/pipeline-data';
import { Router } from 'express';
import { reportDataSource } from '../services/report-runner.js';

const logger = createLogger('report-preview');

/** The template a preview shows. The one a first-time buyer would start from. */
const PREVIEW_TEMPLATE = 'weekly_delivery';

/**
 * The line every preview carries, in the snapshot itself.
 *
 * In the payload rather than only in the UI so it cannot be lost by whoever renders it
 * next — a screenshot of a preview that does not say it is a preview is a number
 * somebody will quote in a meeting.
 */
const WATERMARK = 'PREVIEW — a one-off sample of the Stakeholder Reports add-on. '
  + 'The numbers are your own, for the period shown. Scheduling, review, publishing, '
  + 'email delivery and share links need the add-on.';

export function createReportPreviewRoutes(): Router {
  const router: Router = Router();

  /**
   * `POST /reports/stakeholder-preview` — spend the org's one free preview.
   *
   * `reports:author` rather than `reports:read`: composing a report is the authoring
   * act, and the person evaluating the add-on for a team is the lead who would own the
   * reports. Rate-limited per org on top of the once-ever claim, so a burst cannot turn
   * one preview into a compose loop.
   */
  router.post('/',
    requirePermission('reports:author'),
    rateLimitByOrg({
      name: 'report-preview',
      max: 3,
      windowMs: 300_000,
      message: 'Too many preview attempts — wait a few minutes.',
    }),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const features = (req.user as { features?: string[] } | undefined)?.features ?? [];

      // An entitled org has the real thing, so the preview is refused WITHOUT spending
      // it. Burning somebody's one-off sample on a request they did not need is the kind
      // of small unfairness that generates a support ticket nobody can undo.
      if (features.includes('stakeholder_reports')) {
        return sendError(
          res, 409,
          'This organization already has Stakeholder Reports. Create a report instead — the preview is for accounts that have not bought it.',
          ErrorCode.CONFLICT,
        );
      }

      // Billing off ⇒ every org runs as the unlimited tier ⇒ the feature is already on,
      // so nothing here should ever be reachable. If it is, say so plainly rather than
      // spending a preview an install has no use for.
      if (!isBillingEnabled()) {
        return sendError(
          res, 409,
          'Billing is disabled on this installation, so Stakeholder Reports is already enabled. Create a report instead.',
          ErrorCode.CONFLICT,
        );
      }

      const claimed = await stakeholderReportStore.claimReportPreview(orgId);
      if (!claimed) {
        return sendError(
          res, 409,
          'This organization has already used its free preview. Add Stakeholder Reports to keep producing them.',
          ErrorCode.CONFLICT,
        );
      }

      const template = getTemplate(PREVIEW_TEMPLATE);
      if (!template) {
        // Unreachable unless the template registry changed under us; a 500 is right
        // because the preview WAS claimed and the caller got nothing.
        logger.error('Preview template missing', { template: PREVIEW_TEMPLATE });
        return sendError(res, 500, 'The preview template is unavailable.');
      }

      const period = resolvePeriod('weekly', 'UTC', 'monday');
      try {
        const snapshot = await composeSnapshot(template.sections, {
          source: reportDataSource(orgId),
          period,
          timezone: 'UTC',
          weekStart: 'monday',
          orgId,
          // Composed as if entitled — see the header. The exposure is one report, once.
          features: ['stakeholder_reports', 'advanced_reporting'],
        });
        // LAUNCH METRIC: the PREVIEW-TO-PURCHASE denominator. The numerator is billing's
        // own add-on counter, deliberately — a conversion rate computed inside the feature
        // being sold is a number nobody should trust, and billing already records the sale.
        emitCounter('report_preview_generated_total', {});
        ctx.log('COMPLETED', 'Composed the free report preview', { period: period.label });
        return sendSuccess(res, 200, {
          preview: true,
          watermark: WATERMARK,
          template: PREVIEW_TEMPLATE,
          snapshot: previewSnapshot(snapshot),
        });
      } catch (err) {
        // The claim is NOT rolled back. That looks harsh, and it is the safer of two
        // wrong answers: an org whose compose fails can be given a preview again by
        // support, whereas a rollback makes the claim re-runnable and turns a reliably
        // failing compose into an unbounded free compute loop.
        logger.warn('Preview compose failed after the claim was spent', { orgId, error: errorMessage(err) });
        return sendError(
          res, 500,
          'The preview could not be computed. Contact support — your free preview has not been lost.',
        );
      }
    }));

  /** `GET /reports/stakeholder-preview` — has this org already spent its preview? */
  router.get('/', requirePermission('reports:read'), withRoute(async ({ res, orgId }) => {
    // Read, not a claim: the dashboard asks so it can offer "See a sample" or explain
    // that the sample is spent, before the lead clicks something irreversible.
    return sendSuccess(res, 200, { used: await stakeholderReportStore.reportPreviewUsed(orgId) });
  }));

  return router;
}

/** The snapshot with the watermark folded into its methodology line. */
function previewSnapshot(snapshot: ReportSnapshot): ReportSnapshot {
  return { ...snapshot, methodology: `${WATERMARK}\n\n${snapshot.methodology}` };
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/compliance/posture` — the compliance half of a stakeholder report's
 * posture panel.
 *
 * READ-ONLY, and the only compliance endpoint the `reporting` service may reach. That
 * narrowness is the point: a report needs four counts and a scan date, and nothing
 * here can create a scan, evaluate a rule, or read a rule's CONDITIONS — which are the
 * org's own policy text and none of reporting's business.
 *
 * COUNTS, NOT ROWS. No rule names, no entity ids, no exemption reasons. A manager's
 * report says "48 rules active, last scan blocked 3 of 210 entities"; whoever needs to
 * know WHICH three opens the compliance dashboard, where the permission to see them is
 * already enforced.
 *
 * THE ORG COMES FROM THE TOKEN, not from a path parameter. Reporting mints a
 * per-org service token for the run it is composing, so there is nothing for a caller
 * to disagree with and no way to read a second org's posture by changing a path.
 */

import {
  createLogger,
  errorMessage,
  requireInternalService,
  sendError,
  sendSuccess,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { Router } from 'express';

const logger = createLogger('compliance-posture');

/** Only reporting, and only its own signed token. No user token qualifies. */
const requireReportingService = requireInternalService({ callers: ['reporting'] });

/**
 * A rule is ACTIVE when it is not deleted and its effective window contains now.
 *
 * The window matters: an org that scheduled a rule for next quarter has not got it
 * active, and counting it would tell a manager the org enforces something it does not.
 */
function activeRuleWhere(orgId: string, now: Date) {
  return and(
    eq(schema.complianceRule.orgId, orgId),
    isNull(schema.complianceRule.deletedAt),
    or(isNull(schema.complianceRule.effectiveFrom), sql`${schema.complianceRule.effectiveFrom} <= ${now}`),
    or(isNull(schema.complianceRule.effectiveUntil), sql`${schema.complianceRule.effectiveUntil} > ${now}`),
  );
}

export function createPostureRoutes(): Router {
  const router: Router = Router();

  router.get('/', requireReportingService, withRoute(async ({ res, orgId }) => {
    const now = new Date();
    try {
      const data = await runWithTenantContext({ orgId, isSuperAdmin: false }, async () => withTenantTx(async (tx) => {
        const rules = await tx.select({ tags: schema.complianceRule.tags })
          .from(schema.complianceRule).where(activeRuleWhere(orgId, now));
        // An exemption counts only while APPROVED and unexpired: a pending request is
        // not a carve-out, and an expired one stopped being one.
        const exemptions = await tx.select({ n: sql<number>`COUNT(*)::int` })
          .from(schema.complianceExemption)
          .where(and(
            eq(schema.complianceExemption.orgId, orgId),
            eq(schema.complianceExemption.status, 'approved'),
            or(isNull(schema.complianceExemption.expiresAt), gt(schema.complianceExemption.expiresAt, now)),
          ));
        const scans = await tx.select({
          completedAt: schema.complianceScan.completedAt,
          total: schema.complianceScan.totalEntities,
          pass: schema.complianceScan.passCount,
          warn: schema.complianceScan.warnCount,
          block: schema.complianceScan.blockCount,
        }).from(schema.complianceScan)
          .where(and(
            eq(schema.complianceScan.orgId, orgId),
            eq(schema.complianceScan.status, 'completed'),
          ))
          .orderBy(desc(schema.complianceScan.completedAt))
          .limit(1);

        // Frameworks come off rule TAGS, which is where the org put them. Reporting
        // shows them as a header line ("SOC 2, PCI DSS"), so the set is deduped and
        // sorted here rather than leaving the order to row sequence.
        const frameworks = [...new Set(
          (rules as Array<{ tags: string[] | null }>)
            .flatMap((r) => r.tags ?? [])
            .filter((t) => typeof t === 'string' && t.length > 0),
        )].sort();

        const scan = (scans as Array<{
          completedAt: Date | null; total: number; pass: number; warn: number; block: number;
        }>)[0];
        return {
          activeRules: rules.length,
          activeExemptions: (exemptions as Array<{ n: number }>)[0]?.n ?? 0,
          frameworks,
          lastScan: scan?.completedAt
            ? {
              at: scan.completedAt.toISOString(),
              entities: scan.total,
              passed: scan.pass,
              warnings: scan.warn,
              blocked: scan.block,
            }
            : null,
        };
      }));
      return sendSuccess(res, 200, data);
    } catch (err) {
      // A failure here degrades ONE panel half in the report (the caller treats any
      // non-2xx as "unavailable"), so it is logged and returned plainly rather than
      // dressed up as an empty posture — an empty posture reads as "no rules".
      logger.warn('Compliance posture read failed', { orgId, error: errorMessage(err) });
      return sendError(res, 500, 'Compliance posture could not be read');
    }
  }));

  return router;
}

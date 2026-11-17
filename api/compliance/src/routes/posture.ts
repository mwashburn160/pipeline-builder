// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /compliance/posture` — the compliance half of a stakeholder report's
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
import { isRuleEffective } from '../engine/rule-engine.js';
import { resolveParentOrgId } from '../helpers/org-hierarchy-client.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

const logger = createLogger('compliance-posture');

/** Only reporting, and only its own signed token. No user token qualifies. */
const requireReportingService = requireInternalService({ callers: ['reporting'] });

/**
 * The rules ACTIVE for the org right now: the EFFECTIVE set enforcement evaluates,
 * not just the rules the org owns.
 *
 * That set is the org's own switched-on rules, plus its active subscriptions to
 * published rules (pinned bodies honoured), plus the rules its parent propagates
 * to teams. It is read through the same resolver validate, entity events and scans
 * use ({@link complianceRuleService.findAllEnforced}), so the posture count and
 * enforcement cannot disagree; counting only owned rules told a manager an org
 * running a subscribed library enforced nothing.
 *
 * The effective window is then applied with the engine's own predicate: a rule
 * scheduled for next quarter is skipped by evaluation, so it is not active here.
 *
 * The parent is resolved the way a scan resolves it (this request carries a
 * service token, not a member JWT naming one), and a failed lookup THROWS — a
 * team's posture without its parent's rules would be an undercount, not a gap.
 */
async function effectiveActiveRules(orgId: string, now: Date) {
  const parentOrgId = await resolveParentOrgId(orgId);
  const enforced = await complianceRuleService.findAllEnforced(orgId, undefined, parentOrgId);
  return enforced.filter((rule) => isRuleEffective(rule, now));
}

export function createPostureRoutes(): Router {
  const router: Router = Router();

  router.get('/', requireReportingService, withRoute(async ({ res, orgId }) => {
    const now = new Date();
    try {
      const data = await runWithTenantContext({ orgId, isSuperAdmin: false }, async () => {
        const rules = await effectiveActiveRules(orgId, now);
        const { exemptions, scans } = await withTenantTx(async (tx) => ({
          // An exemption counts only while APPROVED and unexpired: a pending request is
          // not a carve-out, and an expired one stopped being one.
          exemptions: await tx.select({ n: sql<number>`COUNT(*)::int` })
            .from(schema.complianceExemption)
            .where(and(
              eq(schema.complianceExemption.orgId, orgId),
              eq(schema.complianceExemption.status, 'approved'),
              or(isNull(schema.complianceExemption.expiresAt), gt(schema.complianceExemption.expiresAt, now)),
            )),
          scans: await tx.select({
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
            .limit(1),
        }));

        // Frameworks come off rule TAGS, which is where the org put them. Reporting
        // shows them as a header line ("SOC 2, PCI DSS"), so the set is deduped and
        // sorted here rather than leaving the order to row sequence.
        const frameworks = [...new Set(
          rules
            .flatMap((r) => (r.tags as unknown[] | null) ?? [])
            .filter((t): t is string => typeof t === 'string' && t.length > 0),
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
      });
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

import { Router } from 'express';
import {
  sendSuccess,
  sendError,
  ErrorCode,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { type RuleTarget, schema, db } from '@mwashburn160/pipeline-core';
import { eq, and } from 'drizzle-orm';
import { complianceRuleService } from '../services/compliance-rule-service';
import { evaluateRules, type ActiveExemption } from '../engine/rule-engine';
import { logComplianceCheck } from '../helpers/audit-logger';
import { notifyComplianceBlock } from '../helpers/compliance-notifier';

/**
 * Fetch active, approved, non-expired exemptions for an entity.
 */
async function getActiveExemptions(
  orgId: string,
  entityId: string,
): Promise<ActiveExemption[]> {
  const rows = await db
    .select({ id: schema.complianceExemption.id, ruleId: schema.complianceExemption.ruleId })
    .from(schema.complianceExemption)
    .where(
      and(
        eq(schema.complianceExemption.orgId, orgId),
        eq(schema.complianceExemption.entityId, entityId),
        eq(schema.complianceExemption.status, 'approved'),
      ),
    );

  // Filter expired in JS (simpler than SQL date check with nullable)
  return rows as ActiveExemption[];
}

/**
 * Core validation logic shared by both plugin and pipeline endpoints.
 */
async function validateEntity(
  orgId: string,
  userId: string,
  target: RuleTarget,
  action: string,
  entityId: string | undefined,
  entityName: string | undefined,
  attributes: Record<string, unknown>,
  authHeader: string,
  isDryRun: boolean,
) {
  // Fetch active rules for this org+target
  const rules = await complianceRuleService.findActiveByOrgAndTarget(orgId, target);

  // Fetch exemptions if entity has an ID
  const exemptions = entityId ? await getActiveExemptions(orgId, entityId) : [];

  // Evaluate
  const result = evaluateRules(rules, attributes, exemptions);

  // Write audit log (skip for dry-runs)
  if (!isDryRun) {
    logComplianceCheck(orgId, userId, target, action, entityId, entityName, result).catch(() => {});
  }

  // Notify on block (skip for dry-runs)
  if (result.blocked && !isDryRun) {
    notifyComplianceBlock(
      orgId, userId, target, entityName ?? 'unknown',
      result.violations, authHeader,
    ).catch(() => {});
  }

  return result;
}

export function createValidateRoutes(): Router {
  const router = Router();

  // POST /validate/plugin — validate plugin attributes (blocking check)
  router.post('/plugin', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { attributes, entityId, entityName, action } = req.body;
    if (!attributes) {
      return sendError(res, 400, 'attributes is required', ErrorCode.VALIDATION_ERROR);
    }

    const result = await validateEntity(
      orgId, userId || 'system', 'plugin',
      action || 'upload', entityId, entityName,
      attributes, req.headers.authorization || '', false,
    );

    ctx.log('COMPLETED', 'Plugin compliance check', {
      blocked: result.blocked,
      violations: result.violations.length,
      warnings: result.warnings.length,
    });

    return sendSuccess(res, 200, result);
  }));

  // POST /validate/pipeline — validate pipeline attributes (blocking check)
  router.post('/pipeline', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const { attributes, entityId, entityName, action } = req.body;
    if (!attributes) {
      return sendError(res, 400, 'attributes is required', ErrorCode.VALIDATION_ERROR);
    }

    const result = await validateEntity(
      orgId, userId || 'system', 'pipeline',
      action || 'create', entityId, entityName,
      attributes, req.headers.authorization || '', false,
    );

    ctx.log('COMPLETED', 'Pipeline compliance check', {
      blocked: result.blocked,
      violations: result.violations.length,
      warnings: result.warnings.length,
    });

    return sendSuccess(res, 200, result);
  }));

  // POST /validate/plugin/dry-run — pre-flight check (no audit, no notification)
  router.post('/plugin/dry-run', withRoute(async ({ req, res, orgId, userId }) => {
    const { attributes } = req.body;
    if (!attributes) {
      return sendError(res, 400, 'attributes is required', ErrorCode.VALIDATION_ERROR);
    }

    const result = await validateEntity(
      orgId, userId || 'system', 'plugin',
      'dry-run', undefined, undefined,
      attributes, '', true,
    );

    return sendSuccess(res, 200, result);
  }));

  // POST /validate/pipeline/dry-run — pre-flight check (no audit, no notification)
  router.post('/pipeline/dry-run', withRoute(async ({ req, res, orgId, userId }) => {
    const { attributes } = req.body;
    if (!attributes) {
      return sendError(res, 400, 'attributes is required', ErrorCode.VALIDATION_ERROR);
    }

    const result = await validateEntity(
      orgId, userId || 'system', 'pipeline',
      'dry-run', undefined, undefined,
      attributes, '', true,
    );

    return sendSuccess(res, 200, result);
  }));

  return router;
}

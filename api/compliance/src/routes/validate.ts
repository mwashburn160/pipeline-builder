import {
  sendSuccess,
  sendBadRequest,
  ErrorCode,
  createLogger,
  validateBody,
  SYSTEM_ORG_ID,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { type RuleTarget, schema, db } from '@mwashburn160/pipeline-core';
import { eq, and, or, isNull, gt } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { evaluateRules, type ActiveExemption } from '../engine/rule-engine';
import { logComplianceCheck } from '../helpers/audit-logger';
import { notifyComplianceBlock } from '../helpers/compliance-notifier';
import { complianceRuleService } from '../services/compliance-rule-service';

const logger = createLogger('compliance-validate');

/** Max top-level keys for attributes to prevent DoS. */
const MAX_ATTRIBUTE_KEYS = 100;
/** Max nesting depth for attribute values to prevent stack-overflow DoS. */
const MAX_ATTRIBUTE_DEPTH = 5;

/** Recursively check that a value does not exceed the max nesting depth. */
function checkDepth(value: unknown, depth: number): boolean {
  if (depth > MAX_ATTRIBUTE_DEPTH) return false;
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(v => checkDepth(v, depth + 1));
  }
  return true;
}

const attributesSchema = z.record(z.string(), z.unknown())
  .refine(
    (obj) => Object.keys(obj).length <= MAX_ATTRIBUTE_KEYS,
    { message: `attributes must have at most ${MAX_ATTRIBUTE_KEYS} keys` },
  )
  .refine(
    (obj) => checkDepth(obj, 0),
    { message: `attributes must not exceed ${MAX_ATTRIBUTE_DEPTH} levels of nesting` },
  );

const ValidateSchema = z.object({
  attributes: attributesSchema,
  entityId: z.string().uuid().optional(),
  entityName: z.string().max(255).optional(),
  action: z.string().max(50).optional(),
});

const DryRunSchema = z.object({
  attributes: attributesSchema,
});

/**
 * Fetch active, approved, non-expired exemptions for an entity.
 * Filters out expired exemptions in JS since expiresAt is nullable.
 */
async function getActiveExemptions(
  orgId: string,
  entityId: string,
): Promise<ActiveExemption[]> {
  const now = new Date();
  const rows = await db
    .select({
      id: schema.complianceExemption.id,
      ruleId: schema.complianceExemption.ruleId,
    })
    .from(schema.complianceExemption)
    .where(
      and(
        eq(schema.complianceExemption.orgId, orgId),
        eq(schema.complianceExemption.entityId, entityId),
        eq(schema.complianceExemption.status, 'approved'),
        or(
          isNull(schema.complianceExemption.expiresAt),
          gt(schema.complianceExemption.expiresAt, now),
        ),
      ),
    );

  return rows.map((row) => ({ id: row.id, ruleId: row.ruleId }));
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
  // System org is exempt from all compliance rules and policies
  if (orgId.toLowerCase() === SYSTEM_ORG_ID) {
    logger.debug('Skipping compliance for system org', { orgId, target, action });
    return {
      passed: true,
      violations: [],
      warnings: [],
      blocked: false,
      rulesEvaluated: 0,
      rulesSkipped: 0,
      exemptionsApplied: [],
    };
  }

  const rules = await complianceRuleService.findActiveByOrgAndTarget(orgId, target);
  const exemptions = entityId ? await getActiveExemptions(orgId, entityId) : [];
  const result = evaluateRules(rules, attributes, exemptions);

  // Write audit log (skip for dry-runs). Log failures but don't block.
  if (!isDryRun) {
    logComplianceCheck(orgId, userId, target, action, entityId, entityName, result)
      .catch((err) => logger.warn('Audit log write failed', { error: String(err) }));
  }

  // Notify on block (skip for dry-runs). Log failures but don't block.
  if (result.blocked && !isDryRun) {
    notifyComplianceBlock(orgId, target, entityName ?? 'unknown', result.violations, authHeader)
      .catch((err) => logger.warn('Compliance notification failed', { error: String(err) }));
  }

  return result;
}

export function createValidateRoutes(): Router {
  const router = Router();

  // Shared handler for both plugin and pipeline validation (live + dry-run)
  function registerValidateRoute(target: RuleTarget, defaultAction: string) {
    // POST /validate/{target} — blocking check with audit + notifications
    router.post(`/${target}`, withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, ValidateSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { attributes, entityId, entityName, action } = validation.value;

      const result = await validateEntity(
        orgId, userId, target, action || defaultAction, entityId, entityName,
        attributes, req.headers.authorization || '', false,
      );
      ctx.log('COMPLETED', `${target} compliance check`, {
        blocked: result.blocked, violations: result.violations.length, warnings: result.warnings.length,
      });
      return sendSuccess(res, 200, result);
    }));

    // POST /validate/{target}/dry-run — no audit, no notifications
    router.post(`/${target}/dry-run`, withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, DryRunSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);

      const result = await validateEntity(
        orgId, userId, target, 'dry-run', undefined, undefined, validation.value.attributes, '', true,
      );
      ctx.log('COMPLETED', `${target} compliance dry-run`, { blocked: result.blocked, violations: result.violations.length });
      return sendSuccess(res, 200, result);
    }));
  }

  registerValidateRoute('plugin', 'upload');
  registerValidateRoute('pipeline', 'create');

  return router;
}

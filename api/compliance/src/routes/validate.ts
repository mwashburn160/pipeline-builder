import {
  sendSuccess,
  sendBadRequest,
  ErrorCode,
  createLogger,
  validateBody,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { type RuleTarget, schema, db } from '@mwashburn160/pipeline-core';
import { eq, and } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { evaluateRules, type ActiveExemption } from '../engine/rule-engine';
import { logComplianceCheck } from '../helpers/audit-logger';
import { notifyComplianceBlock } from '../helpers/compliance-notifier';
import { complianceRuleService } from '../services/compliance-rule-service';

const logger = createLogger('compliance-validate');

/** Max nesting depth for attributes to prevent DoS via deeply nested payloads. */
const MAX_ATTRIBUTE_KEYS = 100;

const ValidateSchema = z.object({
  attributes: z.record(z.string(), z.unknown()).refine(
    (obj) => Object.keys(obj).length <= MAX_ATTRIBUTE_KEYS,
    { message: `attributes must have at most ${MAX_ATTRIBUTE_KEYS} keys` },
  ),
  entityId: z.string().uuid().optional(),
  entityName: z.string().max(255).optional(),
  action: z.string().max(50).optional(),
});

const DryRunSchema = z.object({
  attributes: z.record(z.string(), z.unknown()).refine(
    (obj) => Object.keys(obj).length <= MAX_ATTRIBUTE_KEYS,
    { message: `attributes must have at most ${MAX_ATTRIBUTE_KEYS} keys` },
  ),
});

/**
 * Fetch active, approved, non-expired exemptions for an entity.
 * Filters out expired exemptions in JS since expiresAt is nullable.
 */
async function getActiveExemptions(
  orgId: string,
  entityId: string,
): Promise<ActiveExemption[]> {
  const rows = await db
    .select({
      id: schema.complianceExemption.id,
      ruleId: schema.complianceExemption.ruleId,
      expiresAt: schema.complianceExemption.expiresAt,
    })
    .from(schema.complianceExemption)
    .where(
      and(
        eq(schema.complianceExemption.orgId, orgId),
        eq(schema.complianceExemption.entityId, entityId),
        eq(schema.complianceExemption.status, 'approved'),
      ),
    );

  const now = new Date();
  return rows
    .filter((row) => !row.expiresAt || new Date(row.expiresAt) > now)
    .map((row) => ({ id: row.id, ruleId: row.ruleId }));
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
    notifyComplianceBlock(orgId, userId, target, entityName ?? 'unknown', result.violations, authHeader)
      .catch((err) => logger.warn('Compliance notification failed', { error: String(err) }));
  }

  return result;
}

export function createValidateRoutes(): Router {
  const router = Router();

  // POST /validate/plugin — validate plugin attributes (blocking check)
  router.post('/plugin', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ValidateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { attributes, entityId, entityName, action } = validation.value;

    const result = await validateEntity(
      orgId, userId, 'plugin',
      action || 'upload', entityId, entityName,
      attributes, req.headers.authorization || '', false,
    );

    ctx.log('COMPLETED', 'Plugin compliance check', {
      blocked: result.blocked, violations: result.violations.length, warnings: result.warnings.length,
    });

    return sendSuccess(res, 200, result);
  }));

  // POST /validate/pipeline — validate pipeline attributes (blocking check)
  router.post('/pipeline', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ValidateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }
    const { attributes, entityId, entityName, action } = validation.value;

    const result = await validateEntity(
      orgId, userId, 'pipeline',
      action || 'create', entityId, entityName,
      attributes, req.headers.authorization || '', false,
    );

    ctx.log('COMPLETED', 'Pipeline compliance check', {
      blocked: result.blocked, violations: result.violations.length, warnings: result.warnings.length,
    });

    return sendSuccess(res, 200, result);
  }));

  // POST /validate/plugin/dry-run — pre-flight check (no audit, no notification)
  router.post('/plugin/dry-run', withRoute(async ({ req, res, orgId, userId }) => {
    const validation = validateBody(req, DryRunSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const result = await validateEntity(
      orgId, userId, 'plugin', 'dry-run', undefined, undefined, validation.value.attributes, '', true,
    );
    return sendSuccess(res, 200, result);
  }));

  // POST /validate/pipeline/dry-run — pre-flight check (no audit, no notification)
  router.post('/pipeline/dry-run', withRoute(async ({ req, res, orgId, userId }) => {
    const validation = validateBody(req, DryRunSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const result = await validateEntity(
      orgId, userId, 'pipeline', 'dry-run', undefined, undefined, validation.value.attributes, '', true,
    );
    return sendSuccess(res, 200, result);
  }));

  return router;
}

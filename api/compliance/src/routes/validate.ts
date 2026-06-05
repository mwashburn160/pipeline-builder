// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendBadRequest,
  ErrorCode,
  createLogger,
  isSystemAdmin,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { type RuleTarget } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { z } from 'zod';
import { evaluateRules } from '../engine/rule-engine';
import { logComplianceCheck } from '../helpers/audit-logger';
import { notifyComplianceBlock } from '../helpers/compliance-notifier';
import { complianceExemptionService } from '../services/compliance-exemption-service';
import { complianceRuleService } from '../services/compliance-rule-service';

const logger = createLogger('compliance-validate');

/** Parse an integer env var, falling back to `fallback` if missing or NaN. */
function parseIntEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max top-level keys for attributes to prevent DoS. Override via
 *  `COMPLIANCE_MAX_ATTRIBUTE_KEYS`. */
const MAX_ATTRIBUTE_KEYS = parseIntEnv(process.env.COMPLIANCE_MAX_ATTRIBUTE_KEYS, 100);
/** Max nesting depth for attribute values to prevent stack-overflow DoS.
 *  Default 10 — real pipeline payloads forwarded from bulk routes nest 5+
 *  levels deep (`attributes.props.stages[].steps[].plugin.field`). A 5-level
 *  cap silently 400'd every bulk pipeline create until we noticed. Override
 *  via `COMPLIANCE_MAX_ATTRIBUTE_DEPTH`. */
const MAX_ATTRIBUTE_DEPTH = parseIntEnv(process.env.COMPLIANCE_MAX_ATTRIBUTE_DEPTH, 10);

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
  isDryRun: boolean,
  isSuperAdmin: boolean,
  parentOrgId?: string,
) {
  // Sysadmins are exempt from compliance rules — they manage the rules
  // and the operator-curated content the rules apply against; running
  // their own checks against their own content would be circular.
  if (isSuperAdmin) {
    logger.debug('Skipping compliance for sysadmin', { orgId, target, action });
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

  // Note: the 'system' org is inert for enforcement — findActiveByOrgAndTarget
  // returns no rules for it (it's the home of the template/published library
  // and the bootstrap catalog, not a tenant), so evaluation below is a no-op.
  const rules = await complianceRuleService.findActiveByOrgAndTarget(orgId, target, parentOrgId);
  const exemptions = entityId
    ? await complianceExemptionService.getActiveExemptionsForEntity(orgId, entityId)
    : [];
  const result = evaluateRules(rules, attributes, exemptions);

  // Write audit log (skip for dry-runs). Log failures but don't block.
  if (!isDryRun) {
    logComplianceCheck(orgId, userId, target, action, entityId, entityName, result)
      .catch((err) => logger.warn('Audit log write failed', { error: String(err) }));
  }

  // Notify on block (skip for dry-runs). Log failures but don't block.
  if (result.blocked && !isDryRun) {
    notifyComplianceBlock(orgId, target, entityName ?? 'unknown', result.violations)
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

      const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
      const result = await validateEntity(
        orgId, userId, target, action || defaultAction, entityId, entityName,
        attributes, false, isSystemAdmin(req), parentOrgId,
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

      const parentOrgId = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
      const result = await validateEntity(
        orgId, userId, target, 'dry-run', undefined, undefined, validation.value.attributes, true, isSystemAdmin(req), parentOrgId,
      );
      ctx.log('COMPLETED', `${target} compliance dry-run`, { blocked: result.blocked, violations: result.violations.length });
      return sendSuccess(res, 200, result);
    }));
  }

  registerValidateRoute('plugin', 'upload');
  registerValidateRoute('pipeline', 'create');

  return router;
}

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
import { type RuleTarget } from '@pipeline-builder/pipeline-data';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { evaluateRules } from '../engine/rule-engine.js';
import { logComplianceCheck } from '../helpers/compliance-check-log.js';
import { notifyComplianceBlock, notifyComplianceWarnings } from '../helpers/compliance-notifier.js';
import { parseIntEnv } from '../helpers/env.js';
import { resolveParentOrgId } from '../helpers/org-hierarchy-client.js';
import { complianceExemptionService } from '../services/compliance-exemption-service.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

const logger = createLogger('compliance-validate');

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
  } else if (!isDryRun && result.warnings.length > 0) {
    // Non-blocking warnings: opt-in per org (notifyOnWarning). Only when not
    // blocked — a block notification already carries the actionable signal.
    notifyComplianceWarnings(orgId, target, entityName ?? 'unknown', result.warnings)
      .catch((err) => logger.warn('Compliance warning notification failed', { error: String(err) }));
  }

  return result;
}

/**
 * Resolve the caller org's direct parent for parent-`propagateToChildren`
 * enforcement. Prefers the JWT claim (`parentOrganizationId`) when present — the
 * fast, no-network path for interactive member tokens. A SERVICE-token caller
 * (e.g. api/pipeline / api/plugin forwarding an upload check) carries NO such
 * claim, yet the team it acts for may still inherit a parent's blocking rules;
 * so when the claim is absent we resolve the parent over the org hierarchy from
 * the request `orgId`. `resolveParentOrgId` returns undefined for a genuine root
 * org and THROWS on a lookup failure (fail-closed) — the throw propagates so the
 * validate call errors rather than stamping a false-pass that skipped inherited
 * rules.
 */
async function resolveParentForValidate(req: Request, orgId: string): Promise<string | undefined> {
  const jwtParent = (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
  if (jwtParent) return jwtParent;
  // Sysadmins are exempt from enforcement (validateEntity returns early), so
  // there is nothing to inherit — skip the network lookup and its throw path.
  if (isSystemAdmin(req)) return undefined;
  return resolveParentOrgId(orgId);
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

      const parentOrgId = await resolveParentForValidate(req, orgId);
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

      const parentOrgId = await resolveParentForValidate(req, orgId);
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

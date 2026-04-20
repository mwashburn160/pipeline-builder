// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendError, sendBadRequest, ErrorCode, createLogger, errorMessage, validateBody } from '@pipeline-builder/api-core';
import type { RuleTarget } from '@pipeline-builder/pipeline-core';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { evaluateRules } from '../engine/rule-engine';
import { logComplianceCheck } from '../helpers/audit-logger';
import { complianceRuleService } from '../services/compliance-rule-service';

const logger = createLogger('compliance-entity-events');

/** Map entity event targets to compliance rule targets. */
const TARGET_MAP: Record<string, RuleTarget | undefined> = {
  plugin: 'plugin',
  pipeline: 'pipeline',
};

const EntityEventSchema = z.object({
  entityId: z.string().min(1),
  orgId: z.string().min(1),
  target: z.string().min(1),
  eventType: z.string().min(1),
  userId: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Internal endpoint for receiving entity lifecycle events from other services.
 * Evaluates compliance rules against mutated entities and logs audit results.
 *
 * This route is called by the compliance event subscriber registered in
 * plugin/pipeline services via `registerComplianceEventSubscriber()`.
 * It is NOT user-facing — only accepts requests with `x-internal-service` header.
 */
export function createEntityEventRoutes(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    // Only accept internal service-to-service calls
    if (req.headers['x-internal-service'] !== 'true') {
      return sendError(res, 403, 'Internal service calls only', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const validation = validateBody(req, EntityEventSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const event = validation.value;
    const ruleTarget = TARGET_MAP[event.target];
    if (!ruleTarget) {
      // Not a compliance-relevant entity type — acknowledge and skip
      return sendSuccess(res, 200, { evaluated: false, reason: 'non-compliance target' });
    }

    try {
      const rules = await complianceRuleService.findActiveByOrgAndTarget(event.orgId, ruleTarget);
      if (rules.length === 0) {
        return sendSuccess(res, 200, { evaluated: false, reason: 'no active rules' });
      }

      const result = evaluateRules(rules, event.attributes || {}, []);

      // Log to audit trail (fire-and-forget for the logging itself)
      logComplianceCheck(
        event.orgId,
        event.userId || 'system',
        ruleTarget,
        event.eventType,
        event.entityId,
        undefined,
        result,
      ).catch((err) => logger.warn('Audit log write failed', { error: String(err) }));

      if (result.blocked || result.warnings.length > 0) {
        logger.info('Entity event compliance result', {
          target: ruleTarget,
          entityId: event.entityId,
          eventType: event.eventType,
          blocked: result.blocked,
          violations: result.violations.length,
          warnings: result.warnings.length,
        });
      }

      return sendSuccess(res, 200, {
        evaluated: true,
        blocked: result.blocked,
        violations: result.violations.length,
        warnings: result.warnings.length,
      });
    } catch (err) {
      logger.error('Entity event compliance evaluation failed', {
        entityId: event.entityId,
        error: errorMessage(err),
      });
      return sendSuccess(res, 200, { evaluated: false, reason: 'evaluation error' });
    }
  });

  return router;
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { RuleTarget } from '@pipeline-builder/pipeline-data';
import { logComplianceCheck } from './audit-logger.js';
import { evaluateRules } from '../engine/rule-engine.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

const logger = createLogger('entity-event-handler');

const TARGET_MAP: Record<string, RuleTarget | undefined> = {
  plugin: 'plugin',
  pipeline: 'pipeline',
};

interface EntityEventInput {
  entityId: string;
  orgId: string;
  /** Owning org's parent (present only when `orgId` is a team). Lets rule lookup
   *  include parent `propagateToChildren` rules, matching live validation. */
  parentOrgId?: string;
  target: string;
  eventType: string;
  userId?: string;
  attributes?: Record<string, unknown>;
}

interface EvaluationResult {
  evaluated: boolean;
  blocked?: boolean;
  violations?: number;
  warnings?: number;
  reason?: string;
  /** True when evaluation ERRORED (vs. legitimately having no rules). The caller
   *  must NOT treat this as success — it should retry rather than fail-open. */
  error?: boolean;
}

/**
 * Evaluate compliance rules against an entity event.
 * Used by both the HTTP entity-events route and the BullMQ worker.
 */
export async function evaluateEntityEvent(event: EntityEventInput): Promise<EvaluationResult> {
  const ruleTarget = TARGET_MAP[event.target];
  if (!ruleTarget) {
    return { evaluated: false, reason: 'non-compliance target' };
  }

  try {
    const rules = await complianceRuleService.findActiveByOrgAndTarget(event.orgId, ruleTarget, event.parentOrgId);
    if (rules.length === 0) {
      return { evaluated: false, reason: 'no active rules' };
    }

    const result = evaluateRules(rules, event.attributes || {}, []);

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

    return {
      evaluated: true,
      blocked: result.blocked,
      violations: result.violations.length,
      warnings: result.warnings.length,
    };
  } catch (err) {
    logger.error('Entity event compliance evaluation failed', {
      entityId: event.entityId,
      error: errorMessage(err),
    });
    // Fail CLOSED: flag the error so the route returns non-2xx and the caller
    // (BullMQ producer) retries — do NOT silently let the entity through.
    return { evaluated: false, reason: 'evaluation error', error: true };
  }
}

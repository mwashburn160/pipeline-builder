import { createLogger, errorMessage } from '@mwashburn160/api-core';
import type { RuleTarget } from '@mwashburn160/pipeline-core';
import { logComplianceCheck } from './audit-logger';
import { evaluateRules } from '../engine/rule-engine';
import { complianceRuleService } from '../services/compliance-rule-service';

const logger = createLogger('entity-event-handler');

const TARGET_MAP: Record<string, RuleTarget | undefined> = {
  plugin: 'plugin',
  pipeline: 'pipeline',
};

export interface EntityEventInput {
  entityId: string;
  orgId: string;
  target: string;
  eventType: string;
  userId?: string;
  attributes?: Record<string, unknown>;
}

export interface EvaluationResult {
  evaluated: boolean;
  blocked?: boolean;
  violations?: number;
  warnings?: number;
  reason?: string;
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
    const rules = await complianceRuleService.findActiveByOrgAndTarget(event.orgId, ruleTarget);
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
    return { evaluated: false, reason: 'evaluation error' };
  }
}

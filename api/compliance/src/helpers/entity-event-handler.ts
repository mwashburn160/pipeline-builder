// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, RULE_TARGETS, type RuleTarget } from '@pipeline-builder/api-core';
import { logComplianceCheck } from './compliance-check-log.js';
import { evaluateEntity } from './evaluate-entity.js';
import { resolveParentOrgId } from './org-hierarchy-client.js';
import { complianceExemptionService } from '../services/compliance-exemption-service.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

const logger = createLogger('entity-event-handler');

/**
 * The event's target as a rule target, or undefined for anything else. Read off
 * api-core's `RULE_TARGETS` rather than a hand-kept `{ plugin, pipeline }` map,
 * whose plain-object lookup also answered for inherited keys (`constructor`).
 */
function ruleTargetOf(target: string): RuleTarget | undefined {
  return (RULE_TARGETS as readonly string[]).includes(target) ? target as RuleTarget : undefined;
}

interface EntityEventInput {
  entityId: string;
  orgId: string;
  target: string;
  eventType: string;
  /** The audit actor: the VERIFIED caller identity (the producing service's
   *  token subject), never a body-supplied user. */
  actorId: string;
  /** The user the producing service says performed the mutation. Unverified —
   *  a log detail only, never the audit actor. */
  requestedBy?: string;
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
 * Evaluate compliance rules against an entity event, for the internal
 * entity-events route (`POST /compliance/internal/events/entity`).
 */
export async function evaluateEntityEvent(event: EntityEventInput): Promise<EvaluationResult> {
  const ruleTarget = ruleTargetOf(event.target);
  if (!ruleTarget) {
    return { evaluated: false, reason: 'non-compliance target' };
  }

  try {
    // The owning org's parent, resolved from the org hierarchy rather than
    // taken from the payload: it decides whether a parent's
    // `propagateToChildren` rules apply, so a body value could drop them.
    // A lookup failure throws (fail-closed) and the caller retries.
    const parentOrgId = await resolveParentOrgId(event.orgId);
    const rules = await complianceRuleService.findActiveByOrgAndTarget(event.orgId, ruleTarget, parentOrgId);
    if (rules.length === 0) {
      return { evaluated: false, reason: 'no active rules' };
    }

    // Honor approved exemptions on the async re-validation path, mirroring the
    // live validate route and the scan executor. Without this, mutating an
    // entity that holds an approved exemption would re-evaluate the waived rule
    // and write a fabricated `result:'block'` row to the audit log.
    const exemptions = await complianceExemptionService.getActiveExemptionsForEntity(
      event.orgId,
      event.entityId,
    );

    // A plugin event carries the stored row; derive the image facts the plugin
    // rules read (`signed`, `scanned`, …) exactly as the live checks send them.
    // A pipeline event gets its resolved step facts when a rule reads them.
    const { result } = await evaluateEntity({
      target: ruleTarget, rules, attributes: event.attributes || {}, orgId: event.orgId, parentOrgId, storedPlugin: true, exemptions,
    });

    logComplianceCheck(
      event.orgId,
      event.actorId,
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
        requestedBy: event.requestedBy,
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
    // retries — do NOT silently let the entity through.
    return { evaluated: false, reason: 'evaluation error', error: true };
  }
}

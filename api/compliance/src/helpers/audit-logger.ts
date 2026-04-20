// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { schema, db, type RuleTarget } from '@pipeline-builder/pipeline-core';
import type { ValidationResult } from '../engine/rule-engine';

/**
 * Write a compliance check result to the audit log.
 */
export async function logComplianceCheck(
  orgId: string,
  userId: string,
  target: RuleTarget,
  action: string,
  entityId: string | undefined,
  entityName: string | undefined,
  result: ValidationResult,
  scanId?: string,
): Promise<void> {
  const auditResult = result.blocked ? 'block' : result.warnings.length > 0 ? 'warn' : 'pass';

  await db.insert(schema.complianceAuditLog).values({
    orgId,
    userId,
    target,
    action,
    entityId: entityId ?? null,
    entityName: entityName ?? null,
    result: auditResult,
    violations: [...result.violations, ...result.warnings] as unknown as Record<string, unknown>[],
    ruleCount: result.rulesEvaluated,
    scanId: scanId ?? null,
  });
}

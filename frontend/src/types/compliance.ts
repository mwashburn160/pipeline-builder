// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance service frontend types.
 */

import type { RuleConditionMode, RuleOperator, RuleScope, RuleSeverity, RuleTarget } from '@pipeline-builder/api-core';

export type { RuleConditionMode, RuleOperator, RuleScope, RuleSeverity, RuleTarget };
export type ExemptionStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ScanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RuleCondition {
  field: string;
  operator: RuleOperator;
  value?: unknown;
  dependsOnRule?: string;
}

export interface CompliancePolicy {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  version: string;
  isTemplate: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Soft-delete tombstone metadata (present on rows returned by list-deleted). */
  deletedAt?: string;
  deletedBy?: string;
}

export interface ComplianceRule {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  policyId?: string;
  priority: number;
  target: RuleTarget;
  severity: RuleSeverity;
  tags: string[];
  effectiveFrom?: string;
  effectiveUntil?: string;
  scope: RuleScope;
  suppressNotification: boolean;
  /** Org → team hierarchy: also enforced on descendant team orgs. */
  propagateToChildren?: boolean;
  field?: string;
  operator?: RuleOperator;
  value?: unknown;
  conditions?: RuleCondition[];
  conditionMode?: RuleConditionMode;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Soft-delete tombstone metadata (present on rows returned by list-deleted). */
  deletedAt?: string;
  deletedBy?: string;
  /** Enforced view only: a rule the team inherits from its parent
   *  (`propagateToChildren`). Read-only in the team — only the source org edits it. */
  inherited?: boolean;
  /** Org that owns an inherited rule. */
  sourceOrgId?: string;
  /** Display name of {@link sourceOrgId}, when the API could resolve it. */
  sourceOrgName?: string;
}

export interface ComplianceRuleHistoryEntry {
  id: string;
  ruleId: string;
  orgId: string;
  changeType: 'created' | 'updated' | 'deleted' | 'restored';
  previousState: Record<string, unknown> | null;
  changedBy: string;
  changedAt: string;
}

/**
 * A validation result and its violations come straight off the wire from the
 * compliance service, so they are re-exported from the api-core client that
 * parses them rather than re-declared here.
 *
 * The local copies had already drifted from that source of truth — `severity`
 * had been narrowed to {@link RuleSeverity} (the service sends a free-form
 * string) and `policyId` had lost its `| null`, which the service does send for
 * an unattached rule. Nothing in the frontend depends on either narrowing:
 * `severity` is only compared against literals, and `policyId` is never read.
 */
export type { ComplianceViolation, ComplianceCheckResult } from '@pipeline-builder/api-core';

export interface ComplianceAuditEntry {
  id: string;
  orgId: string;
  userId: string;
  target: RuleTarget;
  action: string;
  entityId?: string;
  entityName?: string;
  result: 'pass' | 'warn' | 'block';
  violations: Record<string, unknown>[];
  ruleCount: number;
  scanId?: string;
  createdAt: string;
}

export interface ComplianceExemption {
  id: string;
  orgId: string;
  ruleId: string;
  entityType: RuleTarget;
  entityId: string;
  entityName?: string;
  reason: string;
  approvedBy?: string;
  rejectionReason?: string;
  status: ExemptionStatus;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
}

export interface ComplianceScan {
  id: string;
  orgId: string;
  target: string;
  filter?: Record<string, unknown>;
  status: ScanStatus;
  triggeredBy: string;
  userId: string;
  totalEntities: number;
  processedEntities: number;
  passCount: number;
  warnCount: number;
  blockCount: number;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

/** A recurring compliance-scan schedule (cron-driven). Mirrors the row the
 *  compliance service returns from `/compliance/scan-schedules`. */
export interface ScanSchedule {
  id: string;
  target: 'plugin' | 'pipeline' | 'all';
  cronExpression: string;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceRuleCreate {
  name: string;
  description?: string;
  policyId?: string;
  priority?: number;
  target: RuleTarget;
  severity?: RuleSeverity;
  tags?: string[];
  effectiveFrom?: string;
  effectiveUntil?: string;
  scope?: RuleScope;
  suppressNotification?: boolean;
  propagateToChildren?: boolean;
  field?: string;
  operator?: RuleOperator;
  value?: unknown;
  conditions?: RuleCondition[];
  conditionMode?: RuleConditionMode;
}

export interface ComplianceRuleUpdate {
  name?: string;
  description?: string;
  policyId?: string | null;
  priority?: number;
  severity?: RuleSeverity;
  tags?: string[];
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  suppressNotification?: boolean;
  propagateToChildren?: boolean;
  field?: string;
  operator?: RuleOperator;
  value?: unknown;
  conditions?: RuleCondition[];
  conditionMode?: RuleConditionMode;
  isActive?: boolean;
}

export interface ComplianceRuleSubscription {
  id: string;
  orgId: string;
  ruleId: string;
  subscribedBy: string;
  subscribedAt: string;
  isActive: boolean;
  pinnedVersion?: Record<string, unknown> | null;
  unsubscribedAt?: string;
  unsubscribedBy?: string;
}

export interface PublishedRuleCatalogEntry extends ComplianceRule {
  subscribed: boolean;
}

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  target: RuleTarget;
  severity: RuleSeverity;
  field: string;
  operator: string;
  value?: unknown;
  priority: number;
  tags: string[];
  category: string;
}

export interface ExemptionCreate {
  ruleId: string;
  entityType: RuleTarget;
  entityId: string;
  entityName?: string;
  reason: string;
  expiresAt?: string;
}

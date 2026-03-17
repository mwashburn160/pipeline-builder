/**
 * Compliance service frontend types.
 */

export type RuleSeverity = 'warning' | 'error' | 'critical';
export type RuleTarget = 'plugin' | 'pipeline';
export type RuleOperator =
  | 'eq' | 'neq' | 'contains' | 'notContains' | 'regex'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn'
  | 'exists' | 'notExists' | 'countGt' | 'countLt' | 'lengthGt' | 'lengthLt';
export type RuleConditionMode = 'all' | 'any';
export type RuleScope = 'org' | 'global' | 'published';
export type ExemptionStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ScanStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ComplianceRoleType = 'compliance-viewer' | 'compliance-editor' | 'compliance-admin';

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
  field?: string;
  operator?: RuleOperator;
  value?: unknown;
  conditions?: RuleCondition[];
  conditionMode?: RuleConditionMode;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
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

export interface ComplianceViolation {
  ruleId: string;
  ruleName: string;
  policyId?: string;
  field: string;
  operator: string;
  expectedValue: unknown;
  actualValue: unknown;
  severity: RuleSeverity;
  message: string;
}

export interface ComplianceCheckResult {
  passed: boolean;
  violations: ComplianceViolation[];
  warnings: ComplianceViolation[];
  blocked: boolean;
  rulesEvaluated: number;
  rulesSkipped: number;
  exemptionsApplied: string[];
}

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
  unsubscribedAt?: string;
  unsubscribedBy?: string;
}

export interface PublishedRuleCatalogEntry extends ComplianceRule {
  subscribed: boolean;
}

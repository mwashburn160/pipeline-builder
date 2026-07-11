// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse } from '@/types';
import type { CompliancePolicy, ComplianceRule, ComplianceRuleHistoryEntry, ComplianceCheckResult, ComplianceRuleCreate, ComplianceRuleUpdate, ComplianceAuditEntry, ComplianceRuleSubscription, PublishedRuleCatalogEntry, ComplianceExemption, ComplianceScan, RuleTemplate, ExemptionCreate } from '@/types/compliance';

export function complianceApi(core: ApiCore) {
  return {
    // ==========================================================================
    // Compliance notification preferences (per-org; read for members, write for admins)
    // ==========================================================================

    /** Read the calling org's compliance notification preference (defaults when unset). */
    getComplianceNotificationPreference: async () => {
      return core.request<ApiResponse<{ preference: import('@/types/compliance-notifications').ComplianceNotificationPreference }>>(
        '/api/compliance/notification-preferences',
      );
    },

    /** Upsert the calling org's preference (org-admin server-side gate). Omit
     *  `webhookSecret` to keep the existing secret. */
    updateComplianceNotificationPreference: async (body: import('@/types/compliance-notifications').ComplianceNotificationPreferenceWrite) => {
      return core.request<ApiResponse<{ preference: import('@/types/compliance-notifications').ComplianceNotificationPreference }>>(
        '/api/compliance/notification-preferences',
        { method: 'PUT', body: JSON.stringify(body) },
      );
    },

    // ============================================
    // Compliance
    // ============================================

    /** List compliance rules with optional filters */
    getComplianceRules: async (params?: { target?: string; severity?: string; policyId?: string; scope?: string; tag?: string; limit?: number; offset?: number; sortBy?: string; sortOrder?: string }) => {
      return core.request<ApiResponse<{ rules: ComplianceRule[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/compliance/rules${buildQuery(params)}`);
    },

    /** Get rule change history */
    getComplianceRuleHistory: async (id: string) => {
      return core.request<ApiResponse<{ history: ComplianceRuleHistoryEntry[] }>>(`/api/compliance/rules/${id}/history`);
    },

    /** Create a compliance rule */
    createComplianceRule: async (data: ComplianceRuleCreate) => {
      return core.request<ApiResponse<{ rule: ComplianceRule }>>('/api/compliance/rules', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Update a compliance rule */
    updateComplianceRule: async (id: string, data: ComplianceRuleUpdate) => {
      return core.request<ApiResponse<{ rule: ComplianceRule }>>(`/api/compliance/rules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** Delete a compliance rule */
    deleteComplianceRule: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/compliance/rules/${id}`, {
        method: 'DELETE',
      });
    },

    /** Validate plugin attributes against compliance rules (dry-run) */
    dryRunPluginCompliance: async (attributes: Record<string, unknown>) => {
      return core.request<ApiResponse<ComplianceCheckResult>>('/api/compliance/validate/plugin/dry-run', {
        method: 'POST',
        body: JSON.stringify({ attributes }),
      });
    },

    /** Validate pipeline attributes against compliance rules (dry-run) */
    dryRunPipelineCompliance: async (attributes: Record<string, unknown>) => {
      return core.request<ApiResponse<ComplianceCheckResult>>('/api/compliance/validate/pipeline/dry-run', {
        method: 'POST',
        body: JSON.stringify({ attributes }),
      });
    },

    /** Get compliance audit log */
    getComplianceAuditLog: async (params?: { target?: string; result?: string; scanId?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ entries: ComplianceAuditEntry[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/compliance/audit${buildQuery(params)}`);
    },

    // ============================================
    // Compliance Policies
    // ============================================

    /** List compliance policies with optional filters */
    getCompliancePolicies: async (params?: { name?: string; isTemplate?: boolean; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ policies: CompliancePolicy[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/compliance/policies${buildQuery(params)}`);
    },

    /** Create a compliance policy */
    createCompliancePolicy: async (data: { name: string; description?: string; version?: string; ruleNames?: string[] }) => {
      return core.request<ApiResponse<{ policy: CompliancePolicy }>>('/api/compliance/policies', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Update a compliance policy */
    updateCompliancePolicy: async (id: string, data: { name?: string; description?: string; version?: string; isActive?: boolean }) => {
      return core.request<ApiResponse<{ policy: CompliancePolicy }>>(`/api/compliance/policies/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** Delete a compliance policy */
    deleteCompliancePolicy: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/compliance/policies/${id}`, {
        method: 'DELETE',
      });
    },

    // ============================================
    // Published Rules & Subscriptions
    // ============================================

    /** Browse published rules catalog */
    getPublishedRules: async (params?: { target?: string; severity?: string; tag?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ rules: PublishedRuleCatalogEntry[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/compliance/published-rules${buildQuery(params)}`);
    },

    /** List org's subscriptions (active + inactive) */
    getComplianceSubscriptions: async (params?: { limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ subscriptions: (ComplianceRuleSubscription & { rule: ComplianceRule | null })[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/compliance/subscriptions${buildQuery(params)}`);
    },

    /** Subscribe to a published rule (starts inactive) */
    subscribeToRule: async (ruleId: string) => {
      return core.request<ApiResponse<{ subscription: ComplianceRuleSubscription }>>('/api/compliance/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ ruleId }),
      });
    },

    /** Activate or deactivate a subscribed rule */
    setSubscriptionActive: async (ruleId: string, isActive: boolean) => {
      return core.request<ApiResponse<{ subscription: ComplianceRuleSubscription }>>(`/api/compliance/subscriptions/${ruleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
    },

    /** Unsubscribe from a published rule */
    unsubscribeFromRule: async (ruleId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/compliance/subscriptions/${ruleId}`, {
        method: 'DELETE',
      });
    },

    /** Bulk activate/deactivate subscriptions */
    bulkSetSubscriptionActive: async (ruleIds: string[], isActive: boolean) => {
      return core.request<ApiResponse<{ requested: number; updated: number }>>('/api/compliance/subscriptions/bulk', {
        method: 'POST',
        body: JSON.stringify({ ruleIds, isActive }),
      });
    },

    /** Auto-subscribe org to all published rules (inactive by default) */
    autoSubscribe: async () => {
      return core.request<ApiResponse<{ subscribed: number; skipped: number }>>('/api/compliance/subscriptions/auto-subscribe', {
        method: 'POST',
      });
    },

    /** Clone a published rule into org scope (one-shot copy, no upstream tracking). */
    cloneRule: async (ruleId: string) => {
      return core.request<ApiResponse<{ rule: ComplianceRule }>>('/api/compliance/subscriptions/clone', {
        method: 'POST',
        body: JSON.stringify({ ruleId }),
      });
    },

    /** Get all enforced rules (org + active subscribed) */
    getEnforcedRules: async (params?: { target?: string }) => {
      return core.request<ApiResponse<{ rules: ComplianceRule[]; total: number }>>(`/api/compliance/subscriptions/enforced${buildQuery(params)}`);
    },

    /** Pin subscription to current rule version */
    pinSubscription: async (ruleId: string) => {
      return core.request<ApiResponse<{ subscription: ComplianceRuleSubscription }>>(`/api/compliance/subscriptions/${ruleId}/pin`, {
        method: 'POST',
      });
    },

    /** Unpin subscription (use latest rule version) */
    unpinSubscription: async (ruleId: string) => {
      return core.request<ApiResponse<{ subscription: ComplianceRuleSubscription }>>(`/api/compliance/subscriptions/${ruleId}/pin`, {
        method: 'DELETE',
      });
    },

    /** Preview impact of activating a rule against caller-supplied sample attributes (what-if). */
    previewSubscription: async (ruleId: string, sampleAttributes?: Record<string, unknown>) => {
      return core.request<ApiResponse<{ preview?: ComplianceCheckResult; rule?: ComplianceRule }>>('/api/compliance/subscriptions/preview', {
        method: 'POST',
        body: JSON.stringify({ ruleId, sampleAttributes }),
      });
    },

    /**
     * Preview a rule's impact against the caller's existing entities — answers
     * "if I subscribed to this rule today, how many of my plugins/pipelines
     * would fail it right now?". Returns aggregate counts + up to 10 failure samples.
     */
    previewRuleImpact: async (ruleId: string) => {
      return core.request<ApiResponse<{
        ruleId: string;
        ruleName: string;
        target: 'plugin' | 'pipeline';
        total: number;
        wouldPass: number;
        wouldFail: number;
        samples: Array<{ entityType: string; entityId: string; entityName: string | null; messages: string[] }>;
      }>>('/api/compliance/subscriptions/preview/impact', {
        method: 'POST',
        body: JSON.stringify({ ruleId }),
      });
    },

    // ============================================
    // Exemptions
    // ============================================

    /** List exemptions */
    getExemptions: async (params?: { ruleId?: string; entityType?: string; entityId?: string; status?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ exemptions: ComplianceExemption[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/compliance/exemptions${buildQuery(params)}`);
    },

    /** Request an exemption */
    createExemption: async (data: ExemptionCreate) => {
      return core.request<ApiResponse<{ exemption: ComplianceExemption }>>('/api/compliance/exemptions', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Bulk-create exemptions in one request (caps at 500). */
    bulkCreateExemptions: async (exemptions: ExemptionCreate[]) => {
      return core.request<ApiResponse<{ created: number; skipped: number; ids: string[] }>>('/api/compliance/exemptions/bulk', {
        method: 'POST',
        body: JSON.stringify({ exemptions }),
      });
    },

    /** Approve or reject an exemption */
    reviewExemption: async (id: string, status: 'approved' | 'rejected', rejectionReason?: string) => {
      return core.request<ApiResponse<{ exemption: ComplianceExemption }>>(`/api/compliance/exemptions/${id}/review`, {
        method: 'PUT',
        body: JSON.stringify({ status, rejectionReason }),
      });
    },

    /** Delete an exemption */
    deleteExemption: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/compliance/exemptions/${id}`, {
        method: 'DELETE',
      });
    },

    // ============================================
    // Scans
    // ============================================

    /** List compliance scans */
    getScans: async (params?: { target?: string; status?: string; limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{ scans: ComplianceScan[]; pagination?: { total: number; limit: number; offset: number; hasMore: boolean } }>>(`/api/compliance/scans${buildQuery(params)}`);
    },

    /** Get scan by ID */
    getScan: async (id: string) => {
      return core.request<ApiResponse<{ scan: ComplianceScan }>>(`/api/compliance/scans/${id}`);
    },

    /** Trigger a compliance scan */
    triggerScan: async (target: 'plugin' | 'pipeline' | 'all') => {
      return core.request<ApiResponse<{ scan: ComplianceScan }>>('/api/compliance/scans', {
        method: 'POST',
        body: JSON.stringify({ target }),
      });
    },

    /** Cancel a running scan */
    cancelScan: async (id: string) => {
      return core.request<ApiResponse<{ scan: ComplianceScan }>>(`/api/compliance/scans/${id}/cancel`, {
        method: 'POST',
      });
    },

    // ============================================
    // Scan Schedules
    // ============================================

    /** List scan schedules */
    getScanSchedules: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ schedules: Record<string, unknown>[] }>>(`/api/compliance/scan-schedules${buildQuery(params)}`);
    },

    /** Create a scan schedule */
    createScanSchedule: async (data: { target: string; cronExpression: string }) => {
      return core.request<ApiResponse<{ schedule: Record<string, unknown> }>>('/api/compliance/scan-schedules', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Update a scan schedule */
    updateScanSchedule: async (id: string, data: { target?: string; cronExpression?: string }) => {
      return core.request<ApiResponse<{ schedule: Record<string, unknown> }>>(`/api/compliance/scan-schedules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** Toggle scan schedule active state */
    toggleScanScheduleActive: async (id: string, isActive: boolean) => {
      return core.request<ApiResponse<{ schedule: Record<string, unknown> }>>(`/api/compliance/scan-schedules/${id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
    },

    /** Delete a scan schedule */
    deleteScanSchedule: async (id: string) => {
      return core.request<ApiResponse<void>>(`/api/compliance/scan-schedules/${id}`, {
        method: 'DELETE',
      });
    },

    // ============================================
    // Rule Templates
    // ============================================

    /** List available rule templates */
    getRuleTemplates: async () => {
      return core.request<ApiResponse<{ templates: RuleTemplate[] }>>('/api/compliance/templates');
    },

    /** Apply selected templates to org */
    applyRuleTemplates: async (templateIds: string[]) => {
      return core.request<ApiResponse<{ created: number; skipped: number; ruleIds: string[] }>>('/api/compliance/templates/apply', {
        method: 'POST',
        body: JSON.stringify({ templateIds }),
      });
    },
  };
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { InternalHttpClient } from './http-client';
import { ServiceConfig } from '../types/common';
import { createLogger } from '../utils/logger';

const logger = createLogger('compliance-client');

/**
 * When true, compliance checks are bypassed if the service is unavailable
 * (fail-open). Default is fail-closed (errors propagate and block the operation).
 */
const COMPLIANCE_BYPASS = process.env.COMPLIANCE_BYPASS === 'true';

/**
 * Result of a compliance validation check.
 */
export interface ComplianceCheckResult {
  passed: boolean;
  violations: ComplianceViolation[];
  warnings: ComplianceViolation[];
  blocked: boolean;
  rulesEvaluated: number;
  rulesSkipped: number;
  exemptionsApplied: string[];
}

export interface ComplianceViolation {
  ruleId: string;
  ruleName: string;
  policyId?: string | null;
  field: string;
  operator: string;
  expectedValue: unknown;
  actualValue: unknown;
  severity: string;
  message: string;
}

/**
 * Compliance service client interface.
 * Uses fail-closed design: errors propagate to block the operation.
 */
export interface ComplianceClient {
  /** Validate plugin attributes against org rules. Throws on service error (fail-closed). */
  validatePlugin(
    orgId: string,
    attributes: Record<string, unknown>,
    authHeader: string,
    entityId?: string,
    entityName?: string,
    action?: string,
  ): Promise<ComplianceCheckResult>;

  /** Validate pipeline attributes against org rules. Throws on service error (fail-closed). */
  validatePipeline(
    orgId: string,
    attributes: Record<string, unknown>,
    authHeader: string,
    entityId?: string,
    entityName?: string,
    action?: string,
  ): Promise<ComplianceCheckResult>;

  /** Pre-flight check for plugin (no audit, no notification). */
  dryRunPlugin(
    orgId: string,
    attributes: Record<string, unknown>,
    authHeader: string,
  ): Promise<ComplianceCheckResult>;

  /** Pre-flight check for pipeline (no audit, no notification). */
  dryRunPipeline(
    orgId: string,
    attributes: Record<string, unknown>,
    authHeader: string,
  ): Promise<ComplianceCheckResult>;
}

/**
 * Return a pass-through result when COMPLIANCE_BYPASS is enabled and the
 * compliance service is unreachable.
 */
function bypassResult(context: Record<string, unknown>): ComplianceCheckResult {
  logger.warn('COMPLIANCE_BYPASS: Service unavailable, allowing request', context);
  return {
    passed: true,
    blocked: false,
    violations: [],
    warnings: [{ ruleId: '', ruleName: '', field: '', operator: '', expectedValue: null, actualValue: null, severity: 'warning', message: 'Compliance check skipped (service unavailable)' }],
    rulesEvaluated: 0,
    rulesSkipped: 0,
    exemptionsApplied: [],
  };
}

/**
 * Build common request headers for compliance calls.
 */
function buildHeaders(orgId: string, authHeader: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-org-id': orgId,
    'x-internal-service': 'true',
  };
  if (authHeader) headers.Authorization = authHeader;
  return headers;
}

/**
 * Create a compliance client.
 *
 * IMPORTANT: This client is fail-closed — if the compliance service is
 * unreachable or returns an error, the error propagates and the calling
 * operation (plugin upload, pipeline create) is rejected.
 */
export function createComplianceClient(config?: Partial<ServiceConfig>): ComplianceClient {
  const serviceConfig: ServiceConfig = {
    host: config?.host ?? process.env.COMPLIANCE_SERVICE_HOST ?? 'compliance',
    port: config?.port ?? parseInt(process.env.COMPLIANCE_SERVICE_PORT ?? '3000', 10),
  };

  const client = new InternalHttpClient(serviceConfig);

  return {
    async validatePlugin(orgId, attributes, authHeader, entityId, entityName, action) {
      try {
        const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
          '/compliance/validate/plugin',
          { attributes, entityId, entityName, action: action ?? 'upload' },
          { headers: buildHeaders(orgId, authHeader) },
        );
        return response.body.data;
      } catch (error) {
        if (COMPLIANCE_BYPASS) return bypassResult({ orgId, entityType: 'plugin', entityId, entityName });
        throw error;
      }
    },

    async validatePipeline(orgId, attributes, authHeader, entityId, entityName, action) {
      try {
        const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
          '/compliance/validate/pipeline',
          { attributes, entityId, entityName, action: action ?? 'create' },
          { headers: buildHeaders(orgId, authHeader) },
        );
        return response.body.data;
      } catch (error) {
        if (COMPLIANCE_BYPASS) return bypassResult({ orgId, entityType: 'pipeline', entityId, entityName });
        throw error;
      }
    },

    async dryRunPlugin(orgId, attributes, authHeader) {
      try {
        const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
          '/compliance/validate/plugin/dry-run',
          { attributes },
          { headers: buildHeaders(orgId, authHeader) },
        );
        return response.body.data;
      } catch (error) {
        if (COMPLIANCE_BYPASS) return bypassResult({ orgId, entityType: 'plugin', dryRun: true });
        throw error;
      }
    },

    async dryRunPipeline(orgId, attributes, authHeader) {
      try {
        const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
          '/compliance/validate/pipeline/dry-run',
          { attributes },
          { headers: buildHeaders(orgId, authHeader) },
        );
        return response.body.data;
      } catch (error) {
        if (COMPLIANCE_BYPASS) return bypassResult({ orgId, entityType: 'pipeline', dryRun: true });
        throw error;
      }
    },
  };
}

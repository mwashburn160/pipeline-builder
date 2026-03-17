import { InternalHttpClient } from './http-client';
import { ServiceConfig } from '../types/common';

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
      const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
        '/compliance/validate/plugin',
        { attributes, entityId, entityName, action: action ?? 'upload' },
        { headers: buildHeaders(orgId, authHeader) },
      );
      return response.body.data;
    },

    async validatePipeline(orgId, attributes, authHeader, entityId, entityName, action) {
      const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
        '/compliance/validate/pipeline',
        { attributes, entityId, entityName, action: action ?? 'create' },
        { headers: buildHeaders(orgId, authHeader) },
      );
      return response.body.data;
    },

    async dryRunPlugin(orgId, attributes, authHeader) {
      const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
        '/compliance/validate/plugin/dry-run',
        { attributes },
        { headers: buildHeaders(orgId, authHeader) },
      );
      return response.body.data;
    },

    async dryRunPipeline(orgId, attributes, authHeader) {
      const response = await client.post<{ success: boolean; data: ComplianceCheckResult }>(
        '/compliance/validate/pipeline/dry-run',
        { attributes },
        { headers: buildHeaders(orgId, authHeader) },
      );
      return response.body.data;
    },
  };
}

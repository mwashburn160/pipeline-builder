// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { InternalHttpClient, type RequestOptions } from './http-client.js';
import type { ServiceConfig } from '../types/common.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('compliance-client');

/**
 * When true, compliance checks are bypassed if the service is unavailable
 * (fail-open). Default is fail-closed (errors propagate and block the operation).
 */
const COMPLIANCE_BYPASS = process.env.COMPLIANCE_BYPASS === 'true';

/**
 * Per-attempt timeout for a validation POST (env: `COMPLIANCE_VALIDATE_TIMEOUT_MS`).
 * Deliberately TIGHTER than the 5s client default so the enforced retries (below)
 * fit inside a bounded total budget rather than stacking three 5s stalls onto a
 * single interactive request.
 */
const VALIDATE_TIMEOUT_MS = parseInt(process.env.COMPLIANCE_VALIDATE_TIMEOUT_MS ?? '4000', 10);

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
 * The attributes the plugin service sends to `/compliance/validate/plugin`.
 *
 * The spec/config fields describe the plugin as uploaded. The image fields
 * describe what the platform itself established about the pushed image — the
 * facts the curated SOC2/PCI/CIS plugin rules evaluate:
 *
 * - `signed`: the image digest carries the platform's cosign signature.
 * - `scanned`: a vulnerability scan completed (`scannedAt` is set); the
 *   `vuln*` counts are present only then — an unscanned image sends no counts,
 *   so a numeric rule like `vulnCritical lt 1` cannot pass on a missing value.
 * - `runAsRoot`: the image config's effective USER is root (empty, `0`, `root`).
 * - `packages`: package names from the signed SBOM.
 * - `tags`: the plugin's keywords plus `key=value` labels (CIS 2.1 inventory).
 *
 * Image fields are unknown until the build worker has pushed, signed and
 * scanned the image; the upload-time check lists them in `deferredFields`
 * and the worker re-validates once they are real.
 */
export interface PluginComplianceAttributes {
  name?: string;
  version?: string;
  pluginType?: string;
  computeType?: string;
  timeout?: number | null;
  failureBehavior?: string;
  env?: Record<string, string>;
  buildArgs?: Record<string, string>;
  installCommands?: string[];
  commands?: string[];
  visibility?: string;
  secrets?: unknown[];
  metadata?: Record<string, unknown>;
  keywords?: string[];
  buildType?: string;
  tags?: string[];
  signed?: boolean;
  scanned?: boolean;
  vulnCritical?: number;
  vulnHigh?: number;
  vulnMedium?: number;
  vulnLow?: number;
  runAsRoot?: boolean;
  packages?: string[];
  [key: string]: unknown;
}

/** Plugin attributes only the build worker can establish (see {@link PluginComplianceAttributes}). */
export const PLUGIN_IMAGE_COMPLIANCE_FIELDS = [
  'signed', 'scanned', 'vulnCritical', 'vulnHigh', 'vulnMedium', 'vulnLow', 'runAsRoot', 'packages',
] as const;
export type PluginImageComplianceField = typeof PLUGIN_IMAGE_COMPLIANCE_FIELDS[number];

/** The stored plugin-row columns the image facts derive from (any subset). */
export interface PluginImageRow {
  buildType?: unknown;
  pluginType?: unknown;
  imageDigest?: unknown;
  scannedAt?: unknown;
  vulnCritical?: unknown;
  vulnHigh?: unknown;
  vulnMedium?: unknown;
  vulnLow?: unknown;
  runAsRoot?: unknown;
  keywords?: unknown;
  labels?: unknown;
}

const SIGNED_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Whether a plugin runs on its own image: `metadata_only` builds none and a
 * `ManualApprovalStep` never runs one. Same rule as the plugin worker's skip.
 */
export function pluginRunsOwnImage(row: Pick<PluginImageRow, 'buildType' | 'pluginType'>): boolean {
  return row.buildType !== 'metadata_only' && row.pluginType !== 'ManualApprovalStep';
}

/** CIS 2.1 inventory tags: the plugin's keywords plus its labels as `key=value`. */
export function pluginComplianceTags(keywords: unknown, labels?: unknown): string[] {
  const tags = new Set<string>();
  if (Array.isArray(keywords)) {
    for (const k of keywords) if (typeof k === 'string' && k.trim()) tags.add(k.trim());
  }
  if (labels && typeof labels === 'object' && !Array.isArray(labels)) {
    for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') tags.add(`${k}=${String(v)}`);
    }
  }
  return [...tags];
}

const finiteCount = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * The image-derived compliance attributes of a STORED plugin row (the plugin
 * service's update re-check, the build worker's post-build check, and the
 * compliance service's scans and entity events all derive them here, so the
 * rules see one definition of `signed`/`scanned`).
 *
 * - `signed`: the row carries a well-formed digest. The worker stores a digest
 *   only after image-registry signed it (a signing failure fails the build), so
 *   a digest on the row IS a platform signature.
 * - `scanned` + `vuln*`: counts only when `scannedAt` is set.
 * - `runAsRoot`: only when known.
 * - `packages`: not a row column. Pass the SBOM's names when you have them,
 *   `null` when the SBOM could not be read (attribute omitted, so a
 *   `$count(packages)` rule sees 0), or leave it `undefined` on a path that
 *   never reads SBOMs — it is then returned in `deferredFields` (it was
 *   evaluated by the post-build check and cannot change without a rebuild).
 *
 * A plugin that runs no image of its own is honestly unsigned and unscanned
 * with no packages; nothing is deferred for it.
 */
export function derivePluginImageCompliance(
  row: PluginImageRow,
  packages?: string[] | null,
): { attributes: PluginComplianceAttributes; deferredFields: PluginImageComplianceField[] } {
  const tags = pluginComplianceTags(row.keywords, row.labels);
  if (!pluginRunsOwnImage(row)) {
    return { attributes: { tags, signed: false, scanned: false, packages: [] }, deferredFields: [] };
  }
  const scanned = row.scannedAt !== null && row.scannedAt !== undefined;
  const attributes: PluginComplianceAttributes = {
    tags,
    signed: typeof row.imageDigest === 'string' && SIGNED_DIGEST_RE.test(row.imageDigest),
    scanned,
  };
  if (scanned) {
    attributes.vulnCritical = finiteCount(row.vulnCritical);
    attributes.vulnHigh = finiteCount(row.vulnHigh);
    attributes.vulnMedium = finiteCount(row.vulnMedium);
    attributes.vulnLow = finiteCount(row.vulnLow);
  }
  if (typeof row.runAsRoot === 'boolean') attributes.runAsRoot = row.runAsRoot;
  if (Array.isArray(packages)) attributes.packages = packages;
  for (const k of Object.keys(attributes)) if (attributes[k] === undefined) delete attributes[k];
  return { attributes, deferredFields: packages === undefined ? ['packages'] : [] };
}

/**
 * Compliance service client interface.
 * Uses fail-closed design: errors propagate to block the operation.
 */
export interface ComplianceClient {
  /**
   * Validate plugin attributes against org rules. Throws on service error (fail-closed).
   *
   * `deferredFields` names attributes this check cannot know yet; rules that
   * read them are skipped (counted in `rulesSkipped`, never passed) and must be
   * evaluated by a later check that has them — the build worker's post-build
   * re-validation for {@link PLUGIN_IMAGE_COMPLIANCE_FIELDS}.
   */
  validatePlugin(
    orgId: string,
    attributes: PluginComplianceAttributes,
    authHeader: string,
    entityId?: string,
    entityName?: string,
    action?: string,
    deferredFields?: readonly string[],
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
  };
  // NOTE: the old `x-internal-service: true` header was removed — it is trusted
  // by nothing (it was spoofable); compliance routes authenticate the caller via
  // the `Authorization` service JWT (`requireServicePrincipal`).
  if (authHeader) headers.Authorization = authHeader;
  return headers;
}

/**
 * Request options for a compliance validation POST.
 *
 * These calls are side-effect-free (they evaluate rules and return a verdict;
 * any audit/notification the compliance service writes is derived, not a mutation
 * the caller depends on being once-only), so they are marked `idempotent: true`.
 * That lets the HTTP client auto-retry a transient 503 / connection reset /
 * timeout instead of surfacing it as a hard failure — which, under the
 * fail-closed default, would wrongly REJECT a legitimate plugin upload / pipeline
 * create just because compliance briefly stalled. Paired with the tighter
 * per-attempt timeout so the retries stay within a bounded total budget.
 */
function validateOptions(orgId: string, authHeader: string): RequestOptions {
  return {
    headers: buildHeaders(orgId, authHeader),
    idempotent: true,
    timeout: VALIDATE_TIMEOUT_MS,
  };
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

  /**
   * Validate response shape + status. The HTTP client doesn't throw on non-2xx
   * (it just returns the body), so without this an auth failure / route miss
   * silently produced `response.body.data === undefined` and the caller
   * crashed on `.blocked`. Now non-2xx surfaces as a thrown error that the
   * outer try/catch can turn into either fail-closed (default) or
   * COMPLIANCE_BYPASS (fail-open).
   */
  function unwrap(
    response: { statusCode: number; body: { success?: boolean; data?: ComplianceCheckResult; message?: string } },
    op: string,
  ): ComplianceCheckResult {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const msg = response.body?.message ?? `HTTP ${response.statusCode}`;
      throw new Error(`compliance ${op} failed: ${msg}`);
    }
    if (!response.body?.data) {
      throw new Error(`compliance ${op} returned no data (status ${response.statusCode})`);
    }
    return response.body.data;
  }

  // Shared body for all four validate/dry-run calls: POST → unwrap, and on a
  // transport/HTTP failure either return a fail-open bypass result (when
  // COMPLIANCE_BYPASS) or rethrow. The four methods differ ONLY in path, request
  // body, op label, and bypass context.
  async function runValidation(
    orgId: string,
    authHeader: string,
    path: string,
    body: Record<string, unknown>,
    op: string,
    bypassCtx: Record<string, unknown>,
  ): Promise<ComplianceCheckResult> {
    try {
      const response = await client.post<{ success: boolean; data: ComplianceCheckResult; message?: string }>(
        path, body, validateOptions(orgId, authHeader),
      );
      return unwrap(response, op);
    } catch (error) {
      if (COMPLIANCE_BYPASS) return bypassResult(bypassCtx);
      throw error;
    }
  }

  return {
    validatePlugin(orgId, attributes, authHeader, entityId, entityName, action, deferredFields) {
      return runValidation(orgId, authHeader, '/compliance/validate/plugin',
        {
          attributes,
          entityId,
          entityName,
          action: action ?? 'upload',
          ...(deferredFields && deferredFields.length > 0 ? { deferredFields: [...deferredFields] } : {}),
        }, 'validatePlugin',
        { orgId, entityType: 'plugin', entityId, entityName });
    },

    validatePipeline(orgId, attributes, authHeader, entityId, entityName, action) {
      return runValidation(orgId, authHeader, '/compliance/validate/pipeline',
        { attributes, entityId, entityName, action: action ?? 'create' }, 'validatePipeline',
        { orgId, entityType: 'pipeline', entityId, entityName });
    },

    dryRunPlugin(orgId, attributes, authHeader) {
      return runValidation(orgId, authHeader, '/compliance/validate/plugin/dry-run',
        { attributes }, 'dryRunPlugin', { orgId, entityType: 'plugin', dryRun: true });
    },

    dryRunPipeline(orgId, attributes, authHeader) {
      return runValidation(orgId, authHeader, '/compliance/validate/pipeline/dry-run',
        { attributes }, 'dryRunPipeline', { orgId, entityType: 'pipeline', dryRun: true });
    },
  };
}

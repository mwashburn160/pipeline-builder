// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal (service-to-service) endpoint contracts — see `./define.ts`.
 * Each area file holds the endpoints ONE service serves.
 */

import { BILLING_INTERNAL } from './billing.js';
import { COMPLIANCE_INTERNAL } from './compliance.js';
import type { InternalEndpointContract } from './define.js';
import { IMAGE_REGISTRY_INTERNAL } from './image-registry.js';
import { MESSAGE_INTERNAL } from './message.js';
import { PIPELINE_INTERNAL } from './pipeline.js';
import { PLATFORM_INTERNAL } from './platform.js';
import { PLUGIN_INTERNAL } from './plugin.js';
import { QUOTA_INTERNAL } from './quota.js';
import { REPORTING_INTERNAL } from './reporting.js';

export {
  buildContractPath,
  contractErrorMessage,
  contractRoute,
  defineInternalEndpoint,
  parseContractBody,
  parseContractParams,
  parseContractQuery,
  pathParamNames,
  type ContractBody,
  type ContractParams,
  type ContractQuery,
  type ContractResponse,
  type InternalEndpointContract,
  type InternalMethod,
  type QueryValue,
} from './define.js';
export {
  callInternal,
  parseContractResponse,
  ContractRequestError,
  type ContractHttpClient,
  type InternalCallInput,
  type InternalCallResult,
} from './call.js';

// ---- cascade legs (shared shapes) ----
export { CASCADE_LEG_AUTH, CascadeOrgParams, CascadeUserParams, OrgPurgeResponse } from './cascade.js';
// ---- pipeline / compliance / reporting ----
export { PIPELINE_INTERNAL } from './pipeline.js';
export { COMPLIANCE_INTERNAL } from './compliance.js';
export { REPORTING_INTERNAL } from './reporting.js';
// ---- billing ----
export { BILLING_INTERNAL, INCIDENT_KEY_PATTERN } from './billing.js';
// ---- message ----
export {
  MESSAGE_INTERNAL,
  NOTIFY_CONTENT_MAX,
  NOTIFY_SUBJECT_MAX,
  notifyBodyErrorCode,
  type NotifyBody,
  type NotifyBodyErrorCode,
} from './message.js';
// ---- quota ----
export { QUOTA_INTERNAL } from './quota.js';
// ---- image-registry ----
export {
  IMAGE_REGISTRY_INTERNAL,
  PLUGIN_SIGNATURE_HEADERS,
  PluginSignatureHeadersSchema,
  PUBLISHER_HANDLE_RE,
  QUARANTINE_SUBMISSION_ID_RE,
  isPluginRepository,
  isPublicRepository,
  isQuarantineRepository,
  isSha256Digest,
  isSystemPluginRepository,
  parsePublicRepository,
} from './image-registry.js';
// ---- plugin ----
export { PLUGIN_INTERNAL, MAX_REFERENCE_DIGESTS, splitReferenceDigests } from './plugin.js';
// ---- platform ----
export {
  PLATFORM_INTERNAL,
  ECOSYSTEM_DECISION_PERMISSIONS,
  REPORT_EMAIL_MAX_RECIPIENTS,
  notifyEmailLegOf,
  notifyEmailSchema,
  notifyOfferEmailSchema,
  notifyQuotaEmailSchema,
  notifyReportEmailSchema,
  splitIdList,
  type NotifyEmailBody,
  type NotifyEmailLeg,
} from './platform.js';

/** Every internal endpoint contract, for the per-service contract tests. */
export const INTERNAL_CONTRACTS: readonly InternalEndpointContract[] = [
  BILLING_INTERNAL,
  MESSAGE_INTERNAL,
  QUOTA_INTERNAL,
  IMAGE_REGISTRY_INTERNAL,
  PLUGIN_INTERNAL,
  PLATFORM_INTERNAL,
  PIPELINE_INTERNAL,
  COMPLIANCE_INTERNAL,
  REPORTING_INTERNAL,
].flatMap((area) => Object.values(area) as InternalEndpointContract[]);

/** The contracts one service SERVES. */
export function internalContractsServedBy(service: string): InternalEndpointContract[] {
  return INTERNAL_CONTRACTS.filter((c) => c.service === service);
}

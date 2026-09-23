// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export { ErrorCode, getStatusForErrorCode } from './error-codes.js';
export {
  isValidQuotaType,
  type TokenScope,
  TOKEN_SCOPES,
  type PrincipalType,
  type TokenUse,
  type AuthMethod,
  type AssuranceLevel,
  type QuotaType,
  VALID_QUOTA_TYPES,
  type QuotaCheckResult,
  type QuotaInfo,
  type ApiResponse,
  type JwtPayload,
  type HealthCheckResponse,
} from './common.js';
export * from './pipeline.js';
export {
  type Lifecycle,
  type Criticality,
  type OwnerType,
  type EntityLink,
  type EntityLabels,
} from './catalog-metadata.js';
export {
  type TemplateInput,
} from './pipeline-template.js';
export * from './visibility.js';
export * from './wire-vocabulary.js';
export {
  PLUGIN_SUMMARY_MAX,
  PLUGIN_README_MAX_BYTES,
  PLUGIN_CHANGELOG_MAX_BYTES,
  PLUGIN_CATEGORIES,
  type PluginCatalogCategory,
  PLUGIN_CATALOG_FIELDS,
  type PluginCatalogField,
  PLUGIN_CATALOG_LINK_FIELDS,
  METADATA_SOURCES,
  type MetadataSource,
  type MetadataSources,
} from './plugin-catalog.js';
export {
  type HttpRequest,
} from './http.js';
export {
  tierAllowsTeams,
  isBillingEnabled,
  isValidTier,
  getTierLimits,
  type QuotaTier,
  type QuotaTierLimits,
  QUOTA_TIERS,
  VALID_TIERS,
  STANDARD_TIERS,
  TEAM_CAPABLE_TIERS,
  DEFAULT_TIER,
  QUOTA_RESET_DAYS,
  nextQuotaResetDate,
} from './quota-tiers.js';
export * from './feature-flags.js';
export {
  permissionLabel,
  isValidPermission,
  isSystemOrgOnlyPermission,
  isOrgAssignablePermission,
  normalizePermissionSubset,
  intersectPermissions,
  resolveUserPermissions,
  confinePermissionsToOrg,
  hasPermission,
  type Permission,
  ALL_PERMISSIONS,
  PERMISSION_GATES,
  PERMISSION_CATALOG,
  SUPERADMIN_ONLY_PERMISSIONS,
  SYSTEM_ORG_ONLY_PERMISSIONS,
  ORG_ASSIGNABLE_PERMISSIONS,
  ORG_ASSIGNABLE_CATEGORIES,
  READ_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
  ECOSYSTEM_MANAGER_PERMISSIONS,
} from './permissions.js';
export {
  METADATA_KEY_CATALOG,
  MetadataKeys,
  type MetadataKey,
  type MetadataKeyOption,
  METADATA_KEY_GROUPS,
} from './metadata-keys.js';
export {
  type AuditEvent,
} from './audit-events.js';
export {
  ASK_AGENT_PROPOSER,
  PROPOSED_BY_DETAIL_KEY,
  askProposalAuditDetails,
  ORG_SETTING_PROPOSAL_ALLOWLIST,
  ORG_SETTING_PROPOSAL_EXCLUSIONS,
  ORG_SETTING_PROPOSAL_KEYS,
  isProposableOrgSetting,
  isValidOrgSettingValue,
  orgSettingSpec,
  pickAllowed,
  diffOrgSettings,
  orgSettingRequests,
  type AskProposalProvenance,
  type OrgSettingChange,
  type OrgSettingKey,
  type OrgSettingPatch,
  type OrgSettingRequest,
  type OrgSettingShape,
  type OrgSettingSpec,
  type OrgSettingSurface,
  type OrgSettingValue,
  type PickAllowedResult,
} from './ask-proposals.js';
export {
  isEcosystemNotificationEvent,
  parseEcosystemNotifyRequest,
  nextEcosystemDigestTime,
  renderEcosystemManagerChange,
  renderEcosystemDigest,
  type EcosystemNotificationEventId,
  type EcosystemNotificationChannel,
  ECOSYSTEM_EMAIL_PREFERENCE_FIELDS,
  type EcosystemEmailPreferenceField,
  ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES,
  ECOSYSTEM_NOTIFICATION_EVENTS,
  type EcosystemRecipientSpec,
  type EcosystemNotifyRequest,
} from './ecosystem-notifications.js';
export {
  publisherTermsVersion,
  publisherHandleProblem,
  isOfficialAutoApprovalEnabled,
  isPluginPublishingEnabled,
  isAnonymousSubmissionsEnabled,
  isPluginReviewsEnabled,
  OFFICIAL_CATALOG_LOADER_ACCOUNT,
  DEFAULT_PUBLISHER_TERMS_VERSION,
  BUILTIN_RESERVED_HANDLES,
  TENANT_REQUEST_KINDS,
  PUBLISH_PERMISSION_REQUEST_KINDS,
  VERIFY_REQUEST_KINDS,
  STEP_UP_REQUEST_KINDS,
  REQUEST_SLA_HOURS,
} from './ecosystem.js';
export {
  ageScore,
  vulnScore,
  computeHealthScore,
  publisherHealthScore,
  publisherSuccessRate,
  healthBand,
  HEALTH_COMPONENTS,
  HEALTH_WEIGHTS,
  type HealthBreakdown,
  type HealthResult,
  type HealthInputs,
  type HealthBand,
} from './plugin-health.js';
export {
  asScanFlag,
  blockOnNewCritical,
  describeFindings,
  describeFix,
  exceedsVulnFloor,
  pluginVulnMaxCritical,
  SCAN_FLAG_TOP_FINDINGS,
  VULN_FLAGGED_WARNING,
  vulnBlockedMessage,
  vulnFlaggedMessage,
  vulnFlaggedWarning,
  type PluginScanFinding,
  type PluginScanFlag,
  type VulnFlaggedWarning,
} from './plugin-scan.js';

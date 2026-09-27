// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module @pipeline-builder/pipeline-data
 *
 * Database layer: Drizzle ORM schemas, connection management, and query infrastructure.
 *
 * **Database**
 * - db — shared Drizzle database instance
 * - getConnection, closeConnection — PostgreSQL connection lifecycle with retry logic
 * - schema — Drizzle table definitions (plugins, pipelines, messages, compliance, etc.)
 *
 * **Services**
 * - CrudService — generic base class for multi-tenant CRUD with access control and pagination
 * - ReportingService — aggregate query and reporting base class
 *
 * **Query Builders**
 * - buildPluginConditions, buildPipelineConditions, buildMessageConditions — filter-to-SQL condition builders
 * - buildCompliancePolicyConditions, buildComplianceRuleConditions, etc. — compliance query builders
 * - AccessControlBuilder — row-level access control condition builder
 *
 * **Filters**
 * - PluginFilter, PipelineFilter, MessageFilter — typed filter interfaces
 * - CompliancePolicyFilter, ComplianceRuleFilter, etc. — compliance filter interfaces
 * - drizzleRows, drizzleCount — Drizzle result type helpers
 */

// Database
export * from './database/index.js';

// Query builders and services
export * from './api/query-builders.js';
export {
  type BaseAccessFilter,
  AccessControlQueryBuilder,
} from './api/access-control-builder.js';
export * from './api/viewer-context.js';
export * from './api/crud-service.js';
export {
  parseSemver,
  compareSemverParts,
  compareSemver,
  isVersionRange,
  satisfiesVersionSpec,
  semverOrderBy,
} from './api/semver-range.js';
export {
  normalizeQuery,
  searchPublicListings,
  listPublicCategories,
  getPublicListing,
  getPublicListedVersion,
  listPublicReviews,
  listPublicListingsForSitemap,
  type DirectoryTrustTier,
  type DirectorySort,
  DIRECTORY_SORTS,
  DIRECTORY_TIERS,
  type DirectorySearchParams,
  type ReviewSort,
  REVIEW_SORTS,
  type PublicListingRow,
} from './api/public-directory.js';
export {
  policyOf,
  effectiveConsumptionPolicy,
  applyPolicyUpdate,
  type ConsumptionPolicy,
  DEFAULT_CONSUMPTION_POLICY,
} from './api/plugin-consumption-policy.js';
export {
  advisoryRangeCovers,
  advisoryRangeProblem,
  advisoriesCovering,
  blockingAdvisories,
} from './api/plugin-advisories.js';
export {
  listingBlock,
  implicitInstallRange,
  installAdmits,
  scopeOrgIds,
  installModeFor,
  drizzleListingSource,
  resolveListingReference,
  listedVersionWarnings,
  listedPluginRecord,
  loadOrgInstallContext,
  orgListingStates,
  resolvableListings,
  type ResolutionRefusal,
  type ResolutionScope,
  type ListingDataSource,
  type ListingResolved,
  type OrgListingState,
} from './api/plugin-resolution.js';
// `isSoftDeletePurgeEnabled` is the module's own env gate — `runSoftDeletePurge`
// and the scheduler already apply it, so callers never ask separately.
export {
  runSoftDeletePurge,
  createSoftDeletePurgeScheduler,
  type PurgeableEntity,
} from './api/soft-delete-sweep.js';
export {
  type BuildHealth,
  type DoraLevel,
  type DoraMetrics,
  type DoraOptions,
  type DoraTrendPoint,
  type IncidentListItem,
  type ReportingSettings,
  type IncidentTestResult,
  type IngestCaller,
  type IngestMetric,
  type LastDeployedCommit,
} from './api/reporting-service.js';

// The reporting ANALYTICS layer: the per-deploy rollup written at ingest, the
// daily rollup every section reads, and the failure classifier that labels what
// broke (see the modules' own headers for why each is written rather than derived).
export {
  upsertDeployments,
  applyDeployOutcome,
  correlateIncident,
  isDeployEvent,
  leadTimeGapOf,
  type DeployCandidate,
} from './api/reporting/deploy-rollup.js';
export {
  rebuildDay,
  runRollupPass,
  rollupSettleHours,
  rollupBatchDays,
  utcDayStart,
} from './api/reporting/daily-rollup.js';
export {
  classifyFailure,
  isTeamActionable,
  FAILURE_CATEGORY_LABELS,
} from './api/reporting/failure-classifier.js';
export {
  getPipelineBreakdown,
  getFailureAnalysis,
  getStagePerformance,
  getResourceConsumption,
  getPromotionView,
  getOutdatedPlugins,
  getPluginVulnerabilities,
  getAdoption,
  type AnalyticsScope,
  type PipelineBreakdownRow,
  type FailureCategoryRow,
  type StagePerformanceRow,
  type ResourceRow,
  type PromotionRow,
  type OutdatedPluginRow,
  type VulnerabilityRow,
  type AdoptionSummary,
} from './api/reporting/analytics-queries.js';
export {
  evaluateNeedsAttention,
  thresholdsFrom,
  DEFAULT_THRESHOLDS,
  type NeedsAttentionThresholds,
  type AttentionFinding,
  type AttentionItem,
  type AttentionInput,
  type AttentionRuleId,
} from './api/reporting/needs-attention.js';
export {
  replacePipelineResolution,
  refreshLatestForPlugin,
  upsertExposures,
  closeFixedExposures,
  openExposures,
  triageExposure,
  lapsedAcceptances,
  versionGap,
  type ResolvedStep,
  type ExposureInput,
  type VersionGap,
} from './api/reporting/plugin-exposure.js';

// The stakeholder-report engine: period resolution, section registry, templates
// and the composer that freezes a period into a snapshot.
export {
  resolvePeriod,
  resolvePeriodByLabel,
  rejectUnreportablePeriod,
  registerSection,
  getSection,
  allSections,
  sectionIds,
  REPORT_TEMPLATE_SPECS,
  getTemplate,
  composeSnapshot,
  LOW_SAMPLE_THRESHOLD,
  type ResolvedPeriod,
  type PeriodRejection,
  type SectionSpec,
  type SectionContext,
  type SectionDataSource,
  type TemplateSpec,
  type ReportSnapshot,
  type ComposedSection,
  type DataQualityNote,
  type ComposeOptions,
  type TrendDirection,
  StakeholderReportStore,
  stakeholderReportStore,
  hashToken,
  mintToken,
  DEFAULT_SHARE_LINK_TTL_DAYS,
  MAX_SHARE_LINK_TTL_DAYS,
  MAX_BOUNCES,
  VERIFICATION_TTL_MS,
  type CreateDefinitionInput,
  type UpdateDefinitionInput,
  type MintedShareLink,
  type ResolvedShareLink,
} from './api/reporting/stakeholder/index.js';
export {
  type PluginRuntimeFilter,
  type PluginRuntimeStats,
  ReportingService,
  reportingService,
} from './api/reporting-service.js';

// Filters
export {
  type PluginFilter,
  type PipelineFilter,
  type PipelineTemplateFilter,
  type MessageFilter,
  type CompliancePolicyFilter,
  type ComplianceRuleFilter,
  type ComplianceExemptionFilter,
  type ComplianceAuditFilter,
  type ComplianceScanFilter,
} from './core/query-filters.js';

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
  compareSemverLenient,
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
  type DirectorySort,
  DIRECTORY_SORTS,
  type DirectorySearchParams,
  type ReviewSort,
  REVIEW_SORTS,
  type PublicListingRow,
} from './api/public-directory.js';
export {
  listEnabledAlertDestinations,
  type NotificationDestination,
} from './api/alert-destinations.js';
export { anonymizeReviewsByAuthor } from './api/ecosystem-privacy.js';
export {
  ORG_DATA_OWNERSHIP,
  ORG_SCOPED_TABLE_NAMES,
  allOrgScopedTables,
  type OrgDataOwner,
  type OrgDataSlice,
  type OrgScopedTable,
} from './api/org-data-ownership.js';
export {
  purgeOrgData,
  purgeRowCounts,
  type OrgDataPurgeResult,
  type OrgTablePurgeOutcome,
} from './api/org-data-purge.js';
export {
  openSupportCase,
  findCaseByThread,
  listQueue,
  listOrgCases,
  stampFirstResponse,
  setCaseStatus,
  setCaseSeverity,
  assignCase,
  assignCases,
  closeCases,
  transferCaseToContact,
  SUPPORT_CASE_PAGE_MAX,
  type SupportCasePage,
  type SupportCasePageOptions,
  type OpenCaseInput,
  countActiveSupportContacts,
  listActiveSupportContacts,
  isSupportContact,
  designateSupportContact,
  revokeSupportContact,
  // The premium UPGRADE subset. Separate from the baseline contact functions
  // because the two answer to separate caps: an account holds N contacts and
  // upgrades M of them.
  countPremiumSupportContacts,
  isPremiumSupportContact,
  setSupportContactPremium,
  countCasesInWindow,
  rateCase,
  addCaseNote,
  listCaseNotes,
  deleteCaseNote,
  type SupportCaseNote,
  listCannedResponses,
  createCannedResponse,
  updateCannedResponse,
  deleteCannedResponse,
  type CannedResponse,
  listCasesDueForPage,
} from './api/support-cases.js';
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
  type ResolutionWarning,
  type ListingDataSource,
  type ListingResolved,
  type OrgListingState,
  vulnUpgradeAvailableWarning,
  type VulnUpgradeAvailableWarning,
} from './api/plugin-resolution.js';
export {
  resolveManagedToolchain,
  resolveManagedToolchainWith,
  resolveManagedToolchainHalf,
  isEligibleRelease,
  readOrgToolchainOverview,
  listEligibleReleases,
  ManagedToolchainError,
  toolchainOrgChain,
  loadReleaseHalves,
  toolchainCandidateProblems,
  bootstrapToolchainOf,
  setManagedToolchainDepsForTests,
  managedToolchainNamesSql,
  type ManagedToolchainResolution,
  type ManagedToolchainWarning,
  type ManagedToolchainCaller,
  type ManagedToolchainDeps,
  type ToolchainDb,
  type ReleaseHalves,
  type ReleaseLifecycleProblem,
  type OrgToolchainOverview,
  type EligibleToolchainRelease,
} from './api/managed-toolchain.js';
export {
  findVersionReferences,
  distinctPipelines,
  versionReferencedPredicate,
  orgImageDigestsInUse,
  type VersionReferenceTarget,
  type VersionReference,
} from './api/version-references.js';
export {
  declaredResolution,
  recordStepLookup,
  pipelineStepLookups,
  declaredPipelinesForPlugin,
  stepLabelOf,
  type DeclaredStepInput,
  type DeclaredStepPlugin,
  type DeclaredStepResolution,
  type StepLookupRecord,
  type DeclaredPipelineRef,
} from './api/pipeline-step-resolution.js';
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
  type DeploymentOutcomeWrite,
  type IncidentListItem,
  type IncidentState,
  type IncidentWrite,
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
  type DeployCandidate,
} from './api/reporting/deploy-rollup.js';
export {
  runRollupPass,
} from './api/reporting/daily-rollup.js';
export {
  classifyFailure,
} from './api/reporting/failure-classifier.js';
export {
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
  type NeedsAttentionThresholds,
  type AttentionFinding,
  type AttentionItem,
  type AttentionInput,
  type AttentionRuleId,
} from './api/reporting/needs-attention.js';
export {
  replacePipelineResolution,
  refreshLatestForPlugin,
  closePipelineExposures,
  reconcilePipelineExposures,
  syncVersionExposures,
  pipelinesOnVersion,
  openExposures,
  triageExposure,
  pipelineExposures,
  exposureById,
  activeAcceptances,
  acceptanceKey,
  reopenLapsedAcceptances,
  type PipelineExposure,
  type TriageDecision,
  type PipelineAcceptances,
  type LapsedAcceptance,
  type ResolvedStep,
  type ExposureInput,
  type ExposureStep,
  type ExposureCounts,
  type LiveVersion,
  type PipelineOnVersion,
  type PluginVersionRef,
  type ScanState,
  type VersionGap,
} from './api/reporting/plugin-exposure.js';

// Toolchain run data: the
// release stamp on synth / self-mutation rows, the canary gate and the Affected view.
export {
  DEFAULT_CANARY_GATE,
  readAffectedPipelines,
  readCanaryGate,
  readPlatformDefaultRelease,
  type AffectedOrg,
  type AffectedPipelines,
  type CanaryGateInput,
  type CanaryGateParams,
  type CanaryGateResult,
  type CanaryGateShortfall,
  type DeployedToolchain,
  type OrgRuns,
  type ToolchainAction,
  type ToolchainManifestRow,
  type ToolchainOutcome,
} from './api/reporting/toolchain-runs.js';

// The stakeholder-report engine: period resolution, section registry, templates
// and the composer that freezes a period into a snapshot.
export {
  resolvePeriod,
  resolvePeriodByLabel,
  rejectUnreportablePeriod,
  nextPeriodBoundary,
  completePeriodsSince,
  getReportSection,
  getReportTemplate,
  composeSnapshot,
  renderReportHtml,
  reportFileName,
  type ReportHtmlInput,
  type ResolvedPeriod,
  type PeriodRejection,
  type SectionSpec,
  type SectionContext,
  type SectionDataSource,
  type ReportTemplateSpec,
  type ReportSnapshot,
  type ComposedSection,
  type DataQualityNote,
  type ComposeOptions,
  type TrendDirection,
  StakeholderReportStore,
  stakeholderReportStore,
  DEFAULT_SHARE_LINK_TTL_DAYS,
  MAX_SHARE_LINK_TTL_DAYS,
  MAX_REPORT_BOUNCES,
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

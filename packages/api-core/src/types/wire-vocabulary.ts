// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed string vocabularies that cross the wire between the services and the
 * browser. Each is an `as const` array (the runtime list a Zod enum, a Mongoose
 * enum or a drizzle `$type` builds from) plus the union type derived from it.
 *
 * Dependency-free on purpose (no imports at all): the browser imports it
 * directly through the `@pipeline-builder/api-core/wire-vocabulary` subpath, so
 * a frontend catalog derives its order and list from these tuples and a value
 * added here reaches every exhaustive label map as a compile error instead of a
 * silently unhandled string. The Postgres CHECK constraints in each deploy
 * target's `postgres-init.sql` mirror the ones stored in SQL.
 */

// -----------------------------------------------------------------------------
// Compliance rules
// -----------------------------------------------------------------------------

export const RULE_SEVERITIES = ['warning', 'error', 'critical'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const RULE_TARGETS = ['plugin', 'pipeline'] as const;
export type RuleTarget = (typeof RULE_TARGETS)[number];

/** Field-evaluation operators; the engine's implementations live in api/compliance. */
export const RULE_OPERATORS = [
  'eq', 'neq',
  'contains', 'notContains',
  'regex',
  'gt', 'gte', 'lt', 'lte',
  'in', 'notIn',
  'exists', 'notExists', 'notEmpty',
  'countGt', 'countLt',
  'lengthGt', 'lengthLt',
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

/** Operators that test presence only and take no comparison value. */
export const VALUELESS_RULE_OPERATORS = ['exists', 'notExists', 'notEmpty'] as const satisfies readonly RuleOperator[];

/** How a multi-condition rule combines its conditions. */
export const RULE_CONDITION_MODES = ['all', 'any'] as const;
export type RuleConditionMode = (typeof RULE_CONDITION_MODES)[number];

/** `published` rules belong to the system org and apply by subscription. */
export const RULE_SCOPES = ['org', 'published'] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

export const MESSAGE_TYPES = ['announcement', 'conversation'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const MESSAGE_PRIORITIES = ['normal', 'high', 'urgent'] as const;
export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];

/**
 * Who SENT a root message, relative to the viewer: `me` (the viewing user
 * authored it), `org` (the viewing org sent it — any member), `others` (it
 * arrived from another org, announcements included).
 */
export const MESSAGE_SENT_BY = ['me', 'org', 'others'] as const;
export type MessageSentBy = (typeof MESSAGE_SENT_BY)[number];

// -----------------------------------------------------------------------------
// Billing
// -----------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = ['active', 'canceled', 'past_due', 'trialing', 'incomplete'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

// -----------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------

/** OIDC providers an org IdP config can name (GitHub is OAuth-only and refused by the OIDC engine). */
export const IDP_PROVIDERS = ['generic-oidc', 'cognito', 'google', 'github'] as const;
export type IdpProvider = (typeof IDP_PROVIDERS)[number];

/** The federation protocol an org signs in over — one per org. */
export const IDP_PROTOCOLS = ['oidc', 'saml'] as const;
export type IdpProtocol = (typeof IDP_PROTOCOLS)[number];

/**
 * Which SAML assertion attribute carries which identity field. An empty name
 * means "use the common spellings" (short names plus the Entra/Shibboleth URIs).
 */
export interface SamlAttributeMapping {
  /** Attribute holding the user's email address. */
  email?: string;
  /** Attribute holding the display name. */
  name?: string;
  /** Attribute holding group memberships (drives JIT role mapping). */
  groups?: string;
}

/** The coarse grant a permission role gives its members. */
export const ROLE_GRANTS = ['superadmin', 'admin', 'member'] as const;
export type RoleGrant = (typeof ROLE_GRANTS)[number];

// -----------------------------------------------------------------------------
// Plugin ecosystem (each mirrored by a CHECK in postgres-init.sql)
// -----------------------------------------------------------------------------

/** Publisher trust tier. */
export const PUBLISHER_TIERS = ['official', 'verified', 'community', 'unverified'] as const;
export type PublisherTier = (typeof PUBLISHER_TIERS)[number];

/** A directory listing's lifecycle state. */
export const LISTING_STATES = ['listed', 'unmaintained', 'suspended', 'transferred'] as const;
export type ListingState = (typeof LISTING_STATES)[number];

/** What a publish request asks the system org to do. */
export const PUBLISH_REQUEST_KINDS = [
  'new_listing', 'new_version', 'listing_update', 'yank', 'unpause',
  'transfer', 'claim', 'profile_change', 'advisory', 'verify', 'moderation', 'submission',
] as const;
export type PublishRequestKind = (typeof PUBLISH_REQUEST_KINDS)[number];

export const PUBLISH_REQUEST_STATUSES = ['pending', 'pending_second_approval', 'approved', 'rejected', 'withdrawn'] as const;
export type PublishRequestStatus = (typeof PUBLISH_REQUEST_STATUSES)[number];

/** The statuses a request is still "open" in (drives the one-open-request index). */
export const OPEN_PUBLISH_REQUEST_STATUSES = ['pending', 'pending_second_approval'] as const satisfies readonly PublishRequestStatus[];

/** `security` requests jump the moderation queue. */
export const PUBLISH_REQUEST_LANES = ['standard', 'security'] as const;
export type PublishRequestLane = (typeof PUBLISH_REQUEST_LANES)[number];

/** Install version policy: exact, `~`, `^`, or anything non-breaking. */
export const INSTALL_VERSION_POLICIES = ['pinned', 'patch', 'minor', 'latest'] as const;
export type InstallVersionPolicy = (typeof INSTALL_VERSION_POLICIES)[number];

export const INSTALL_STATUSES = ['active', 'pending_approval', 'denied'] as const;
export type InstallStatus = (typeof INSTALL_STATUSES)[number];

/** The advisory severity at which a consumption policy blocks installs. */
export const BLOCK_ON_ADVISORY_LEVELS = ['critical', 'high', 'never'] as const;
export type BlockOnAdvisory = (typeof BLOCK_ON_ADVISORY_LEVELS)[number];

/** Whether official plugins need an explicit install before a pipeline can use them. */
export const OFFICIAL_INSTALLS_MODES = ['implicit', 'explicit'] as const;
export type OfficialInstalls = (typeof OFFICIAL_INSTALLS_MODES)[number];

/**
 * What happens when an org defines a plugin NAME that overrides something it
 * would otherwise resolve — a listing, or (for a team) its parent org's plugin.
 *
 * `allow` keeps today's behaviour: the override is silent beyond the dashboard
 * banner. `warn` is the same resolution with the fact recorded prominently.
 * `deny` refuses the upload, which is the only setting that actually stops a
 * team replacing the Official `trivy` for every pipeline that names it.
 */
export const SHADOWING_MODES = ['allow', 'warn', 'deny'] as const;
export type ShadowingMode = (typeof SHADOWING_MODES)[number];

export const REVIEW_STATUSES = ['published', 'held', 'removed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Why a held review is held. */
export const REVIEW_HOLD_REASONS = ['reports', 'burst', 'filter', 'security', 'moderator'] as const;
export type ReviewHoldReason = (typeof REVIEW_HOLD_REASONS)[number];

/** A review report's category; `security` routes privately to the advisory path. */
export const REVIEW_REPORT_CATEGORIES = ['spam', 'abuse', 'off_topic', 'security'] as const;
export type ReviewReportCategory = (typeof REVIEW_REPORT_CATEGORIES)[number];

export const ADVISORY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number];

export const ADVISORY_STATES = ['draft', 'published', 'withdrawn'] as const;
export type AdvisoryState = (typeof ADVISORY_STATES)[number];

export const ADVISORY_SOURCES = ['publisher', 'moderator', 'cve_rescan', 'review'] as const;
export type AdvisorySource = (typeof ADVISORY_SOURCES)[number];

/**
 * An anonymous submission's lifecycle. `publishing` is the short claim an
 * approval takes before it copies the quarantined image out, so an expiry can
 * never delete the artifacts of a submission that is being published.
 */
export const SUBMISSION_STATUSES = [
  'pending_verification', 'pending_review', 'publishing', 'gate_failed', 'approved', 'rejected', 'expired', 'claimed',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

// -----------------------------------------------------------------------------
// Plugin security notifications (per org)
// -----------------------------------------------------------------------------

/** Who receives an org's plugin security notices: `writers` = the uploader plus
 *  members holding `plugins:write`; `users` = the org's chosen members. */
export const PLUGIN_SECURITY_RECIPIENT_MODES = ['writers', 'users'] as const;
export type PluginSecurityRecipientMode = (typeof PLUGIN_SECURITY_RECIPIENT_MODES)[number];

/** How rescan findings (N31) are batched; blocked builds (N30) are always immediate. */
export const PLUGIN_SECURITY_DIGEST_MODES = ['immediate', 'daily', 'weekly'] as const;
export type PluginSecurityDigestMode = (typeof PLUGIN_SECURITY_DIGEST_MODES)[number];

// The build CLASS and SIZE vocabularies live in `build-catalog.ts`, together
// with their labels, credit multipliers, tier floors and per-class slot
// defaults. They are not here because the ids alone were never the whole fact:
// the multiplier was in this file, the tier gate was in `quota-tiers.ts`, and
// the labels were in a frontend mirror of both. One keyed catalog is importable
// by the browser, so the mirror and the test that parsed this package's source
// to detect drift are both gone.

// -----------------------------------------------------------------------------
// Org membership
// -----------------------------------------------------------------------------

/**
 * The coarse per-org membership label (`UserOrganization.role`,
 * `Invitation.role`, the access token's `role`), highest authority first:
 * `owner` created the org or received an ownership transfer, `admin` manages
 * members and settings, `member` has standard access. DERIVED from the Roles a
 * user is assigned (the highest `grantsRole` among them; `owner` only by
 * transfer) — a display/authority label driving `isAdmin`, ownership and seat
 * accounting, NOT a permission source (see `resolveUserPermissions`).
 */
export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * The membership roles that ADMINISTER an org: the token's `isAdmin`, the
 * "notify this org's admins" lookups and the invite/approval authority checks
 * all read this one list.
 */
export const ADMIN_ORG_ROLES = ['owner', 'admin'] as const satisfies readonly OrgRole[];
export type AdminOrgRole = (typeof ADMIN_ORG_ROLES)[number];

/** Whether `value` is a membership role, narrowing it. */
export function isOrgRole(value: unknown): value is OrgRole {
  return (ORG_ROLES as readonly unknown[]).includes(value);
}

/** Whether `role` administers its org (`owner` or `admin`). */
export function isAdminOrgRole(role: unknown): role is AdminOrgRole {
  return (ADMIN_ORG_ROLES as readonly unknown[]).includes(role);
}

// -----------------------------------------------------------------------------
// Alerting
// -----------------------------------------------------------------------------

/** Where an org's alert destination delivers (`alert_destinations.channel`). */
export const ALERT_CHANNELS = ['slack', 'webhook', 'in-app', 'email'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/**
 * The severity ladder an org sets on its alert rules and uses as a
 * destination's `minSeverity` floor, least severe first (`warning` =
 * warning+critical, `critical` = critical only). Mirrors Alertmanager severity
 * ordering. An inbound alert may also carry `info`, which no rule can emit and
 * no destination can subscribe to.
 */
export const ALERT_RULE_SEVERITIES = ['warning', 'critical'] as const;
export type AlertRuleSeverity = (typeof ALERT_RULE_SEVERITIES)[number];

// -----------------------------------------------------------------------------
// Support cases
// -----------------------------------------------------------------------------

/** A support case's lifecycle state (`support_cases.status`). */
export const SUPPORT_CASE_STATUSES = ['open', 'awaiting_support', 'awaiting_customer', 'resolved', 'closed'] as const;
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number];

/**
 * The statuses a TENANT may set on its own case. `awaiting_support` and
 * `resolved` are the support desk's to set; `closed` is the tenant's way out
 * (and, once there, a tenant cannot move the case back).
 */
export const TENANT_SUPPORT_CASE_STATUSES = ['open', 'awaiting_customer', 'closed'] as const satisfies readonly SupportCaseStatus[];
export type TenantSupportCaseStatus = (typeof TENANT_SUPPORT_CASE_STATUSES)[number];

/** Statuses a tenant cannot move OUT of. */
export const TENANT_TERMINAL_SUPPORT_CASE_STATUSES = ['closed'] as const satisfies readonly TenantSupportCaseStatus[];

/** Statuses a case is still LIVE in (not resolved or closed). */
export const LIVE_SUPPORT_CASE_STATUSES = ['open', 'awaiting_support', 'awaiting_customer'] as const satisfies readonly SupportCaseStatus[];

// -----------------------------------------------------------------------------
// Compliance scans, exemptions and checks
// -----------------------------------------------------------------------------

/** What a compliance scan (or a scan schedule) covers: one rule target, or every one. */
export const COMPLIANCE_SCAN_TARGETS = [...RULE_TARGETS, 'all'] as const;
export type ComplianceScanTarget = (typeof COMPLIANCE_SCAN_TARGETS)[number];

export const COMPLIANCE_SCAN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type ComplianceScanStatus = (typeof COMPLIANCE_SCAN_STATUSES)[number];

/** Why a scan row exists. `rule-dry-run` scans evaluate without writing the check log or notifying. */
export const COMPLIANCE_SCAN_TRIGGERS = ['manual', 'scheduled', 'rule-change', 'rule-dry-run'] as const;
export type ComplianceScanTrigger = (typeof COMPLIANCE_SCAN_TRIGGERS)[number];

export const COMPLIANCE_EXEMPTION_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ComplianceExemptionStatus = (typeof COMPLIANCE_EXEMPTION_STATUSES)[number];

/** The two decisions a reviewer can make on a pending exemption. */
export const COMPLIANCE_EXEMPTION_DECISIONS = ['approved', 'rejected'] as const satisfies readonly ComplianceExemptionStatus[];
export type ComplianceExemptionDecision = (typeof COMPLIANCE_EXEMPTION_DECISIONS)[number];

/** A compliance check-log row's verdict (`compliance_check_log.result`). */
export const COMPLIANCE_CHECK_RESULTS = ['pass', 'warn', 'block'] as const;
export type ComplianceCheckVerdict = (typeof COMPLIANCE_CHECK_RESULTS)[number];

// -----------------------------------------------------------------------------
// AI calls
// -----------------------------------------------------------------------------

/** Whose key serves an AI call: the caller's own (`request`, BYOK), the org's, or the platform's. Only `platform` spends `aiCalls`. */
export const AI_KEY_SOURCES = ['platform', 'org', 'request'] as const;
export type AiKeySource = (typeof AI_KEY_SOURCES)[number];

/**
 * How an AI call's `aiCalls` quota slot settled: `kept` (the call reached a
 * provider), `refunded` (it never did), or `waived` (no unit was reserved — a
 * BYOK key, an impersonated call or a weight-0 model).
 */
export const AI_QUOTA_SETTLEMENTS = ['kept', 'refunded', 'waived'] as const;
export type AiQuotaSettlement = (typeof AI_QUOTA_SETTLEMENTS)[number];

// -----------------------------------------------------------------------------
// Plugin-version vulnerability grades
// -----------------------------------------------------------------------------

/** How loud a plugin-version vulnerability warning is, quietest first (see `services/version-vuln-policy.ts`). */
export const VULN_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type VulnSeverity = (typeof VULN_SEVERITIES)[number];

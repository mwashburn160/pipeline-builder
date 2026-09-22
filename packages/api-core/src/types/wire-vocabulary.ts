// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed string vocabularies that cross the wire between the services and the
 * browser. Each is an `as const` array (the runtime list a Zod enum, a Mongoose
 * enum or a drizzle `$type` builds from) plus the union type derived from it.
 *
 * Dependency-free on purpose: the frontend imports these types, so a value added
 * here reaches the UI's exhaustive label maps as a compile error instead of a
 * silently unhandled string. The Postgres CHECK constraints in
 * deploy/shared/postgres-init.sql mirror the ones stored in SQL.
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

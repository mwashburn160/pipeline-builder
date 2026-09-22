// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

//
// Plugin ecosystem tables (docs/plugin-publishing.md). Mirrors the
// "PLUGIN ECOSYSTEM" section of postgres-init.sql, which is authoritative for
// the trigger-maintained `search_vector`, the RLS policies and the public views.
//
// Two kinds of table:
//   * ECOSYSTEM-GLOBAL — publishers, listings, listing versions, the publish
//     request queue, reviews, advisories, anonymous submissions, … The
//     directory is instance-wide, so these carry NO `org_id`: they are not
//     tenant scoped, writes are gated in the service layer (system-org-only
//     approval), and their RLS policy admits the application role only.
//     `publishers.owner_org_id` is deliberately not named `org_id`: a publisher
//     outlives its org, so it must stay out of the org cascade, which
//     treats every `org_id` table as the org's data.
//   * ORG-SCOPED — pipeline_step_manifests, plugin_installs,
//     plugin_install_policies, plugin_advisory_deliveries: `org_id` + the
//     standard `rls_org_*` policies + FORCE, and part of the org cascade.
//
// The two `public_*` views are declared with `pgView(...).existing()` (drizzle
// never creates them; postgres-init.sql does). They are what the anonymous
// directory API reads, connected as `ecosystem_public_reader` — the only
// relations that role can SELECT. They are exported for typed queries but kept
// out of the aggregate `schema` object, which lists tables only.
//

import type {
  PublisherTier,
  ListingState,
  PublishRequestKind,
  PublishRequestStatus,
  PublishRequestLane,
  InstallVersionPolicy,
  InstallStatus,
  BlockOnAdvisory,
  OfficialInstalls,
  ReviewStatus,
  ReviewHoldReason,
  ReviewReportCategory,
  AdvisorySeverity,
  AdvisoryState,
  AdvisorySource,
  SubmissionStatus,
  PluginScanFlag,
  PluginSecurityRecipientMode,
  PluginSecurityDigestMode,
} from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import {
  boolean, check, customType, doublePrecision, index, integer, jsonb, pgTable, pgView, primaryKey, smallint, text,
  timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core';
import type { PluginIcon, PluginSecret, PluginUploadedIcon } from './plugin.js';

/** Per-component health scores; mirrors api-core's `HealthBreakdown`. */
export type HealthBreakdown = Record<string, { score: number | null; weight: number }>;

/** Postgres `tsvector`, which drizzle-orm has no native column for. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ---------------------------------------------------------------------------
// Enumerations — defined in api-core's wire vocabulary so the frontend shares
// them; each is mirrored by a CHECK in postgres-init.sql
// ---------------------------------------------------------------------------

export {
  PUBLISHER_TIERS,
  LISTING_STATES,
  PUBLISH_REQUEST_KINDS,
  PUBLISH_REQUEST_STATUSES,
  OPEN_PUBLISH_REQUEST_STATUSES,
  INSTALL_VERSION_POLICIES,
  REVIEW_HOLD_REASONS,
  REVIEW_REPORT_CATEGORIES,
  SUBMISSION_STATUSES,
  type PublisherTier,
  type ListingState,
  type PublishRequestKind,
  type PublishRequestStatus,
  type PublishRequestLane,
  type InstallVersionPolicy,
  type InstallStatus,
  type BlockOnAdvisory,
  type OfficialInstalls,
  type ReviewStatus,
  type ReviewHoldReason,
  type ReviewReportCategory,
  type AdvisorySeverity,
  type AdvisoryState,
  type AdvisorySource,
  type SubmissionStatus,
} from '@pipeline-builder/api-core';

/**
 * A member's pending request to CHANGE an active install (its version or
 * version policy) that needs an approver — crossing a major/breaking version,
 * or widening to `latest`, on an approval-gated tier. One per install; an
 * approver (`plugin_installs:manage`) applies or rejects it.
 */
export interface InstallChangeRequest {
  /** The version the install would move to. */
  version: string;
  /** The version policy it would move to. */
  versionPolicy: InstallVersionPolicy;
  requestedBy: string;
  /** ISO time of the request. */
  requestedAt: string;
  note: string | null;
}
/** A `(publisher, name)` an org's consumption policy blocks. */
export interface BlockedListingRef {
  publisher: string;
  name: string;
}

/** An anonymous submission's accepted catalog metadata and per-field provenance. */
export interface SubmissionCatalog {
  values: Record<string, unknown>;
  sources: Record<string, string>;
}

/** Notification event number (`N1` … `N29`). */
export type EcosystemNotificationEvent = `N${number}`;

// ---------------------------------------------------------------------------
// Ecosystem-global tables
// ---------------------------------------------------------------------------

/**
 * An org's public identity (one per root org). `ownerOrgId` is NULL for the
 * platform-owned `community` publisher anonymous submissions land under.
 *
 * @table publishers
 */
export const publisher = pgTable('publishers', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerOrgId: varchar('owner_org_id', { length: 255 }).unique(),
  handle: varchar('handle', { length: 39 }).notNull().unique(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  description: text('description'),
  homepageUrl: varchar('homepage_url', { length: 2048 }),
  tier: varchar('tier', { length: 20 }).$type<PublisherTier>().default('community').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  // Verified publisher downgraded below Team keeps the tier until this passes (N29).
  verifiedGraceUntil: timestamp('verified_grace_until', { withTimezone: true }),
  termsVersion: varchar('terms_version', { length: 50 }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendReason: text('suspend_reason'),
  // W7 roll-ups, written by the stats sweep: run-weighted 30-day success rate
  // and the install-weighted mean health score of its listings (NULL: none).
  successRate30d: doublePrecision('success_rate_30d'),
  healthScore: integer('health_score'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  handleCheck: check('publishers_handle_check', sql`${table.handle} ~ '^[a-z0-9][a-z0-9-]*$'`),
  tierCheck: check('publishers_tier_check',
    sql`${table.tier} IN ('official', 'verified', 'community', 'unverified')`),
}));

/**
 * A plugin NAME published by a publisher. Reviews, installs, stats and search
 * attach here; the per-version records are {@link pluginListingVersion}.
 * `searchVector` is maintained by a trigger in postgres-init.sql (name A,
 * keywords + category B, summary C, README + description D, config `english`)
 * — never write it from the application.
 *
 * @table plugin_listings
 */
export const pluginListing = pgTable('plugin_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  publisherId: uuid('publisher_id').notNull().references(() => publisher.id),
  name: varchar('name', { length: 255 }).notNull(),
  category: varchar('category', { length: 50 }).default('unknown').notNull(),
  summary: varchar('summary', { length: 300 }),
  description: text('description'),
  readmeHtml: text('readme_html'),
  license: varchar('license', { length: 64 }),
  homepageUrl: varchar('homepage_url', { length: 2048 }),
  sourceUrl: varchar('source_url', { length: 2048 }),
  icon: jsonb('icon').$type<PluginIcon>(),
  uploadedIcon: jsonb('uploaded_icon').$type<PluginUploadedIcon>(),
  keywords: jsonb('keywords').$type<string[]>().default([]).notNull(),
  state: varchar('state', { length: 20 }).$type<ListingState>().default('listed').notNull(),
  // Publisher pause: no new installs; existing installs keep resolving.
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  featured: boolean('featured').default(false).notNull(),
  latestVersion: varchar('latest_version', { length: 50 }),
  searchVector: tsvector('search_vector'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  publisherNameUnique: uniqueIndex('plugin_listing_publisher_name_unique').on(table.publisherId, table.name),
  stateCategoryIdx: index('plugin_listing_state_category_idx').on(table.state, table.category),
  updatedAtIdx: index('plugin_listing_updated_at_idx').on(table.updatedAt),
  searchVectorIdx: index('plugin_listing_search_vector_idx').using('gin', table.searchVector),
  // pg_trgm: typo-tolerant name matching ("terafrom" -> terraform).
  nameTrgmIdx: index('plugin_listing_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  stateCheck: check('plugin_listings_state_check',
    sql`${table.state} IN ('listed', 'unmaintained', 'suspended', 'transferred')`),
}));

/**
 * The public, frozen subset of a plugin record captured at approval, so a
 * listed version keeps synthesizing after the publisher org's own `plugins`
 * row is deleted or purged. Only the keys the `public_listed_versions`
 * view projects are public; the rest is visible to installers' synth only.
 */
export interface ListingVersionSpecSnapshot {
  pluginType?: string;
  computeType?: string;
  secrets?: PluginSecret[];
  requiredMetadata?: string[];
  requiredVars?: string[];
  networkEgress?: string[];
  runAsRoot?: boolean;
  license?: string;
  readmeHtml?: string;
  [key: string]: unknown;
}

/**
 * A version published to a listing — the copy in the read-only `public/*`
 * namespace. Immutable once written apart from pause / yank /
 * deprecation. `sourcePluginId` is provenance only (no FK: the org row is
 * soft-deleted and purged on its own schedule).
 *
 * @table plugin_listing_versions
 */
export const pluginListingVersion = pgTable('plugin_listing_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => pluginListing.id, { onDelete: 'cascade' }),
  sourcePluginId: uuid('source_plugin_id'),
  version: varchar('version', { length: 50 }).notNull(),
  imageDigest: varchar('image_digest', { length: 71 }),
  // public/<handle>/<name>
  imageRepository: varchar('image_repository', { length: 512 }),
  specSnapshot: jsonb('spec_snapshot').$type<ListingVersionSpecSnapshot>().default({}).notNull(),
  breaking: boolean('breaking').default(false).notNull(),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  yankedAt: timestamp('yanked_at', { withTimezone: true }),
  yankReason: text('yank_reason'),
  deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
  deprecationMessage: text('deprecation_message'),
  changelog: text('changelog'),
  vulnCritical: integer('vuln_critical'),
  vulnHigh: integer('vuln_high'),
  // Fixable subset (grype reports a fixed version); NULL = unscanned.
  vulnCriticalFixable: integer('vuln_critical_fixable'),
  vulnHighFixable: integer('vuln_high_fixable'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }),
  // The nightly rescan's flag (fixable criticals over PLUGIN_VULN_MAX_CRITICAL); NULL = not flagged.
  scanFlaggedAt: timestamp('scan_flagged_at', { withTimezone: true }),
  scanFlag: jsonb('scan_flag').$type<PluginScanFlag>(),
  // The base image's config `created` time, recorded at publish; NULL = unknown.
  baseImageCreatedAt: timestamp('base_image_created_at', { withTimezone: true }),
  // When maintenance collected this long-yanked, unreferenced version's public/* image; NULL = still stored.
  imageCollectedAt: timestamp('image_collected_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
  publishedBy: text('published_by').notNull(),
}, (table) => ({
  listingVersionUnique: uniqueIndex('plugin_listing_version_unique').on(table.listingId, table.version),
  // public/* GC guard + digest lookups.
  digestIdx: index('plugin_listing_version_digest_idx').on(table.imageDigest),
  versionCheck: check('plugin_listing_versions_version_check',
    sql`${table.version} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$'`,
  ),
  imageDigestCheck: check('plugin_listing_versions_image_digest_check',
    sql`${table.imageDigest} IS NULL OR ${table.imageDigest} ~ '^sha256:[0-9a-f]{64}$'`),
}));

/**
 * Security advisory against a listing's version range.
 *
 * @table plugin_advisories
 */
export const pluginAdvisory = pgTable('plugin_advisories', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => pluginListing.id),
  publisherId: uuid('publisher_id').notNull().references(() => publisher.id),
  // Semver range of affected versions.
  affectedRange: varchar('affected_range', { length: 255 }).notNull(),
  fixedVersion: varchar('fixed_version', { length: 50 }),
  severity: varchar('severity', { length: 10 }).$type<AdvisorySeverity>().notNull(),
  summary: varchar('summary', { length: 300 }).notNull(),
  detailsMd: text('details_md'),
  detailsHtml: text('details_html'),
  cveIds: text('cve_ids').array().default([]).notNull(),
  state: varchar('state', { length: 20 }).$type<AdvisoryState>().default('draft').notNull(),
  source: varchar('source', { length: 20 }).$type<AdvisorySource>().notNull(),
  createdBy: text('created_by').notNull(),
  publishedBy: text('published_by'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  listingStateIdx: index('plugin_advisory_listing_state_idx').on(table.listingId, table.state),
  publisherIdx: index('plugin_advisory_publisher_idx').on(table.publisherId),
  severityCheck: check('plugin_advisories_severity_check',
    sql`${table.severity} IN ('critical', 'high', 'medium', 'low')`),
  stateCheck: check('plugin_advisories_state_check', sql`${table.state} IN ('draft', 'published', 'withdrawn')`),
  sourceCheck: check('plugin_advisories_source_check',
    sql`${table.source} IN ('publisher', 'moderator', 'cve_rescan', 'review')`),
}));

/**
 * A proposed enable or widening of an auto-approval rule, waiting for a SECOND
 * Ecosystem Manager (never the proposer). Disabling or deleting a rule
 * narrows it and applies at once.
 */
export interface AutoApprovalRulePendingChange {
  requestedBy: string;
  requestedAt: string;
  enabled: boolean;
  name: string;
  conditions: Record<string, unknown>;
}

/**
 * System-org auto-approval rules; enabling or widening one
 * needs a second approver (`pendingChange`).
 *
 * @table ecosystem_auto_approval_rules
 */
export const ecosystemAutoApprovalRule = pgTable('ecosystem_auto_approval_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  conditions: jsonb('conditions').$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: text('created_by').notNull(),
  // Second approver (never the creator).
  approvedBy: text('approved_by'),
  pendingChange: jsonb('pending_change').$type<AutoApprovalRulePendingChange>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The single queue the Ecosystem console works from. `digest` is pinned
 * at submit: approval publishes exactly it, or fails closed. `pluginId`
 * has no FK (the org row is soft-deleted and purged on its own schedule).
 *
 * @table plugin_publish_requests
 */
export const pluginPublishRequest = pgTable('plugin_publish_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  publisherId: uuid('publisher_id').notNull().references(() => publisher.id),
  listingId: uuid('listing_id').references(() => pluginListing.id),
  pluginId: uuid('plugin_id'),
  version: varchar('version', { length: 50 }),
  digest: varchar('digest', { length: 71 }),
  kind: varchar('kind', { length: 20 }).$type<PublishRequestKind>().notNull(),
  securityFixAdvisoryId: uuid('security_fix_advisory_id').references(() => pluginAdvisory.id),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  status: varchar('status', { length: 30 }).$type<PublishRequestStatus>().default('pending').notNull(),
  lane: varchar('lane', { length: 10 }).$type<PublishRequestLane>().default('standard').notNull(),
  submittedBy: text('submitted_by').notNull(),
  submittedOrgId: varchar('submitted_org_id', { length: 255 }),
  firstApprovedBy: text('first_approved_by'),
  decidedBy: text('decided_by'),
  secondApprovedBy: text('second_approved_by'),
  reason: text('reason'),
  autoRuleId: uuid('auto_rule_id').references(() => ecosystemAutoApprovalRule.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (table) => ({
  statusCreatedIdx: index('plugin_publish_request_status_created_idx').on(table.status, table.createdAt),
  publisherIdx: index('plugin_publish_request_publisher_idx').on(table.publisherId, table.createdAt),
  // At most ONE open request of a kind per (publisher, listing, version). A
  // new_listing has no listing yet, so the requested name (payload->>'name')
  // stands in; COALESCE because NULLs are DISTINCT in a unique index. Advisory
  // drafts are exempt: a listing can carry several at once (different ranges
  // and CVE sets), each deduplicated by the advisory service. Must match the
  // postgres-init.sql expression index.
  openUnique: uniqueIndex('plugin_publish_request_open_unique')
    .on(
      table.publisherId,
      table.kind,
      sql`coalesce(${table.listingId}::text, ${table.payload}->>'name', '')`,
      sql`coalesce(${table.version}, '')`,
    )
    .where(sql`status IN ('pending', 'pending_second_approval') AND kind <> 'advisory'`),
  digestCheck: check('plugin_publish_requests_digest_check',
    sql`${table.digest} IS NULL OR ${table.digest} ~ '^sha256:[0-9a-f]{64}$'`),
  kindCheck: check('plugin_publish_requests_kind_check', sql`${table.kind} IN ('new_listing', 'new_version',
    'listing_update', 'yank', 'unpause', 'transfer', 'claim', 'profile_change', 'advisory', 'verify', 'moderation',
    'submission')`),
  statusCheck: check('plugin_publish_requests_status_check',
    sql`${table.status} IN ('pending', 'pending_second_approval', 'approved', 'rejected', 'withdrawn')`),
  laneCheck: check('plugin_publish_requests_lane_check', sql`${table.lane} IN ('standard', 'security')`),
}));

/**
 * Names held back from handles/listings (Official/Verified reservations,
 * confusables). `publisherId` = the publisher the name is reserved FOR, if any.
 *
 * @table ecosystem_reserved_names
 */
export const ecosystemReservedName = pgTable('ecosystem_reserved_names', {
  name: varchar('name', { length: 255 }).primaryKey(),
  reason: text('reason'),
  publisherId: uuid('publisher_id').references(() => publisher.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Instance-wide ecosystem knobs (flags, SLA, thresholds), key/value.
 *
 * @table ecosystem_settings
 */
export const ecosystemSetting = pgTable('ecosystem_settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Curated directory collections ("Featured", "Security scanners", …).
 *
 * @table ecosystem_collections
 */
export const ecosystemCollection = pgTable('ecosystem_collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  listingIds: jsonb('listing_ids').$type<string[]>().default([]).notNull(),
  position: integer('position').default(0).notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A listing review. `authorOrgId` feeds the integrity rules (no
 * self-review, per-org rate limit, verified use) and is NEVER exposed. GDPR
 * user deletion anonymizes: `authorUserId` and the body go NULL, the rating stays.
 *
 * @table plugin_reviews
 */
export const pluginReview = pgTable('plugin_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => pluginListing.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 50 }),
  rating: smallint('rating').notNull(),
  title: varchar('title', { length: 120 }),
  bodyMd: text('body_md'),
  bodyHtml: text('body_html'),
  authorUserId: text('author_user_id'),
  authorOrgId: varchar('author_org_id', { length: 255 }),
  // The only author field ever shown (snapshot at write time; NULL once anonymized).
  authorDisplayName: varchar('author_display_name', { length: 100 }),
  verifiedUse: boolean('verified_use').default(false).notNull(),
  status: varchar('status', { length: 10 }).$type<ReviewStatus>().default('published').notNull(),
  holdReason: varchar('hold_reason', { length: 20 }).$type<ReviewHoldReason>(),
  moderationReason: text('moderation_reason'),
  helpfulCount: integer('helpful_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  listingAuthorUnique: uniqueIndex('plugin_review_listing_author_unique').on(table.listingId, table.authorUserId),
  listingStatusCreatedIdx: index('plugin_review_listing_status_created_idx')
    .on(table.listingId, table.status, table.createdAt),
  // Per-org daily review cap.
  authorOrgCreatedIdx: index('plugin_review_author_org_created_idx').on(table.authorOrgId, table.createdAt),
  // Moderation queue.
  statusUpdatedIdx: index('plugin_review_status_updated_idx').on(table.status, table.updatedAt),
  ratingCheck: check('plugin_reviews_rating_check', sql`${table.rating} BETWEEN 1 AND 5`),
  statusCheck: check('plugin_reviews_status_check', sql`${table.status} IN ('published', 'held', 'removed')`),
  holdReasonCheck: check('plugin_reviews_hold_reason_check',
    sql`${table.holdReason} IN ('reports', 'burst', 'filter', 'security', 'moderator')`),
}));

/**
 * The one public publisher reply to a review.
 *
 * @table plugin_review_replies
 */
export const pluginReviewReply = pgTable('plugin_review_replies', {
  reviewId: uuid('review_id').primaryKey().references(() => pluginReview.id, { onDelete: 'cascade' }),
  publisherId: uuid('publisher_id').notNull().references(() => publisher.id),
  authorUserId: text('author_user_id'),
  bodyMd: text('body_md').notNull(),
  bodyHtml: text('body_html').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * "Report review" — one per reporter per review; N reports auto-hold it.
 *
 * @table plugin_review_reports
 */
export const pluginReviewReport = pgTable('plugin_review_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id').notNull().references(() => pluginReview.id, { onDelete: 'cascade' }),
  reporterUserId: text('reporter_user_id').notNull(),
  category: varchar('category', { length: 20 }).$type<ReviewReportCategory>().default('abuse').notNull(),
  reason: text('reason'),
  // Set once a moderator released or removed the review.
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  reviewReporterUnique: uniqueIndex('plugin_review_report_unique').on(table.reviewId, table.reporterUserId),
  openIdx: index('plugin_review_report_open_idx').on(table.reviewId).where(sql`${table.resolvedAt} IS NULL`),
  categoryCheck: check('plugin_review_reports_category_check',
    sql`${table.category} IN ('spam', 'abuse', 'off_topic', 'security')`),
}));

/**
 * One "helpful" vote per user per review.
 *
 * @table plugin_review_votes
 */
export const pluginReviewVote = pgTable('plugin_review_votes', {
  reviewId: uuid('review_id').notNull().references(() => pluginReview.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.reviewId, table.userId] }),
}));

/**
 * Review edit history: the PRIOR content, appended on every edit.
 *
 * @table plugin_review_history
 */
export const pluginReviewHistory = pgTable('plugin_review_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id').notNull().references(() => pluginReview.id, { onDelete: 'cascade' }),
  version: varchar('version', { length: 50 }),
  rating: smallint('rating').notNull(),
  title: varchar('title', { length: 120 }),
  bodyMd: text('body_md'),
  editedAt: timestamp('edited_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  reviewIdx: index('plugin_review_history_review_idx').on(table.reviewId, table.editedAt),
  ratingCheck: check('plugin_review_history_rating_check', sql`${table.rating} BETWEEN 1 AND 5`),
}));

/**
 * Denormalized per-listing stats, recomputed by a job. `activeOrgCount` is
 * public only when >= 5 (the `public_listings` view enforces it).
 *
 * @table plugin_stats
 */
export const pluginStats = pgTable('plugin_stats', {
  listingId: uuid('listing_id').primaryKey().references(() => pluginListing.id, { onDelete: 'cascade' }),
  ratingBayes: doublePrecision('rating_bayes'),
  ratingCount: integer('rating_count').default(0).notNull(),
  // Star distribution: { "1": n, …, "5": n }.
  dist: jsonb('dist').$type<Record<string, number>>().default({}).notNull(),
  // "Recent versions" rating over the last two minors.
  recentRating: doublePrecision('recent_rating'),
  installCount: integer('install_count').default(0).notNull(),
  activeOrgCount: integer('active_org_count').default(0).notNull(),
  successRate30d: doublePrecision('success_rate_30d'),
  healthScore: doublePrecision('health_score'),
  // Per-component health scores and weights, for the breakdown panel.
  healthBreakdown: jsonb('health_breakdown').$type<HealthBreakdown>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Anonymous public submission. The email is kept hashed (rate limits,
 * claim matching) and encrypted (takedown notices only) and purged at
 * `emailPurgeAfter`. Nothing here is ever listed or resolvable.
 *
 * @table plugin_submissions
 */
export const pluginSubmission = pgTable('plugin_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: varchar('status', { length: 30 }).$type<SubmissionStatus>().default('pending_verification').notNull(),
  emailHash: varchar('email_hash', { length: 64 }),
  emailEnc: text('email_enc'),
  verifyTokenHash: varchar('verify_token_hash', { length: 64 }),
  verifyExpiresAt: timestamp('verify_expires_at', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  // sha256 of the status token (returned by verify and in N1/N3/N4 emails) —
  // the submitter's only read handle on the submission.
  statusTokenHash: varchar('status_token_hash', { length: 64 }),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  spec: jsonb('spec').$type<Record<string, unknown>>().default({}).notNull(),
  // The accept-or-edit catalog values + provenance and the Dockerfile,
  // captured at submit so moderation reviews exactly what was submitted.
  catalog: jsonb('catalog').$type<SubmissionCatalog>().default({ values: {}, sources: {} }).notNull(),
  dockerfile: text('dockerfile'),
  artifactKey: varchar('artifact_key', { length: 1024 }),
  quarantineImageRef: varchar('quarantine_image_ref', { length: 1024 }),
  gateReport: jsonb('gate_report').$type<Record<string, unknown>>(),
  heuristics: jsonb('heuristics').$type<Record<string, unknown>>(),
  listingId: uuid('listing_id').references(() => pluginListing.id),
  decidedBy: text('decided_by'),
  reason: text('reason'),
  clientIpHash: varchar('client_ip_hash', { length: 64 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  emailPurgeAfter: timestamp('email_purge_after', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  statusCreatedIdx: index('plugin_submission_status_created_idx').on(table.status, table.createdAt),
  // Per-email / per-IP daily rate limits.
  emailCreatedIdx: index('plugin_submission_email_created_idx').on(table.emailHash, table.createdAt),
  ipCreatedIdx: index('plugin_submission_ip_created_idx').on(table.clientIpHash, table.createdAt),
  verifyTokenUnique: uniqueIndex('plugin_submission_verify_token_unique')
    .on(table.verifyTokenHash)
    .where(sql`verify_token_hash IS NOT NULL`),
  statusTokenUnique: uniqueIndex('plugin_submission_status_token_unique')
    .on(table.statusTokenHash)
    .where(sql`status_token_hash IS NOT NULL`),
  statusCheck: check('plugin_submissions_status_check', sql`${table.status} IN ('pending_verification',
    'pending_review', 'publishing', 'gate_failed', 'approved', 'rejected', 'expired', 'claimed')`),
}));

/**
 * Zero-result directory searches. No user data. `query` is stored normalized;
 * the maintenance sweep folds repeats of one (query, category) into a single
 * row counting `hits`, with `created_at` = the latest one, and prunes rows not
 * seen for 30 days.
 *
 * @table ecosystem_search_misses
 */
export const ecosystemSearchMiss = pgTable('ecosystem_search_misses', {
  id: uuid('id').primaryKey().defaultRandom(),
  query: varchar('query', { length: 200 }).notNull(),
  category: varchar('category', { length: 50 }),
  hits: integer('hits').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  createdAtIdx: index('ecosystem_search_miss_created_idx').on(table.createdAt),
  hitsCheck: check('ecosystem_search_misses_hits_check', sql`${table.hits} >= 1`),
}));

/**
 * Notification digest/batching queue. Rows sharing a `digestKey` are
 * coalesced into one email at `deliverAfter`.
 *
 * @table ecosystem_notification_queue
 */
export const ecosystemNotificationQueue = pgTable('ecosystem_notification_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  recipientUserId: text('recipient_user_id'),
  recipientOrgId: varchar('recipient_org_id', { length: 255 }),
  event: varchar('event', { length: 8 }).$type<EcosystemNotificationEvent>().notNull(),
  digestKey: varchar('digest_key', { length: 255 }),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  deliverAfter: timestamp('deliver_after', { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // The dispatcher's scan: undelivered rows that are due.
  dueIdx: index('ecosystem_notification_due_idx').on(table.deliverAfter).where(sql`delivered_at IS NULL`),
  digestIdx: index('ecosystem_notification_digest_idx').on(table.digestKey).where(sql`delivered_at IS NULL`),
  eventCheck: check('ecosystem_notification_queue_event_check', sql`${table.event} ~ '^N([1-9]|1[0-9]|2[0-9])$'`),
}));

// ---------------------------------------------------------------------------
// Org-scoped tables (org_id + rls_org_* policies + FORCE; in the org cascade)
// ---------------------------------------------------------------------------

/**
 * Step manifest: which plugin each (pipeline, stage, action) runs,
 * recorded at synth. Event ingest joins on it to stamp
 * `pipeline_events.plugin_*`. `pluginPublisher` is NULL for an own-org plugin.
 *
 * @table pipeline_step_manifests
 */
export const pipelineStepManifest = pgTable('pipeline_step_manifests', {
  pipelineId: uuid('pipeline_id').notNull(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  stageName: varchar('stage_name', { length: 255 }).notNull(),
  actionName: varchar('action_name', { length: 255 }).notNull(),
  pluginPublisher: varchar('plugin_publisher', { length: 39 }),
  /** The listing publisher's id (NULL for an own-org plugin) — what cross-org stats join on. */
  pluginPublisherId: uuid('plugin_publisher_id'),
  pluginName: varchar('plugin_name', { length: 255 }).notNull(),
  pluginVersion: varchar('plugin_version', { length: 50 }).notNull(),
  imageDigest: varchar('image_digest', { length: 71 }),
  imageRepository: varchar('image_repository', { length: 512 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.pipelineId, table.stageName, table.actionName] }),
  orgIdx: index('pipeline_step_manifest_org_idx').on(table.orgId),
  // public/* GC guard: "does any manifest still reference this digest?"
  digestIdx: index('pipeline_step_manifest_digest_idx').on(table.imageDigest),
  pluginIdx: index('pipeline_step_manifest_plugin_idx').on(table.pluginPublisher, table.pluginName),
  pluginPublisherIdIdx: index('pipeline_step_manifest_publisher_id_idx').on(table.pluginPublisherId, table.pluginName),
}));

/**
 * An org's install of a listing. Official listings are installed
 * implicitly (virtual — no row); a row is an explicit install or override.
 *
 * @table plugin_installs
 */
export const pluginInstall = pgTable('plugin_installs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  listingId: uuid('listing_id').notNull().references(() => pluginListing.id, { onDelete: 'cascade' }),
  versionPolicy: varchar('version_policy', { length: 10 }).$type<InstallVersionPolicy>().default('minor').notNull(),
  pinnedVersion: varchar('pinned_version', { length: 50 }),
  resolvedVersion: varchar('resolved_version', { length: 50 }),
  status: varchar('status', { length: 20 }).$type<InstallStatus>().default('active').notNull(),
  installedBy: text('installed_by').notNull(),
  approvedBy: text('approved_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /** A pending, approval-gated change of this install (upgrade / policy), or null. */
  pendingChange: jsonb('pending_change').$type<InstallChangeRequest>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgListingUnique: uniqueIndex('plugin_install_org_listing_unique').on(table.orgId, table.listingId),
  // "Installing orgs" fan-out for N8/N13/N14/N21/N26.
  listingStatusIdx: index('plugin_install_listing_status_idx').on(table.listingId, table.status),
  versionPolicyCheck: check('plugin_installs_version_policy_check',
    sql`${table.versionPolicy} IN ('pinned', 'patch', 'minor', 'latest')`),
  statusCheck: check('plugin_installs_status_check', sql`${table.status} IN ('active', 'pending_approval', 'denied')`),
  pinnedCheck: check('plugin_install_pinned_check',
    sql`${table.versionPolicy} <> 'pinned' OR ${table.pinnedVersion} IS NOT NULL`),
}));

/**
 * Org consumption policy. One row per org; absent = the column defaults.
 * None of these safety controls is plan-gated.
 *
 * @table plugin_install_policies
 */
export const pluginInstallPolicy = pgTable('plugin_install_policies', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  allowedTiers: text('allowed_tiers').array().$type<PublisherTier[]>()
    .default(['official', 'verified']).notNull(),
  requireApprovalTiers: text('require_approval_tiers').array().$type<PublisherTier[]>()
    .default(['community', 'unverified']).notNull(),
  secretsAllowedTiers: text('secrets_allowed_tiers').array().$type<PublisherTier[]>()
    .default(['official', 'verified']).notNull(),
  blockOnAdvisory: varchar('block_on_advisory', { length: 10 }).$type<BlockOnAdvisory>().default('critical').notNull(),
  officialInstalls: varchar('official_installs', { length: 10 }).$type<OfficialInstalls>().default('implicit').notNull(),
  blockedListings: jsonb('blocked_listings').$type<BlockedListingRef[]>().default([]).notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  blockOnAdvisoryCheck: check('plugin_install_policies_block_on_advisory_check',
    sql`${table.blockOnAdvisory} IN ('critical', 'high', 'never')`),
  officialInstallsCheck: check('plugin_install_policies_official_installs_check',
    sql`${table.officialInstalls} IN ('implicit', 'explicit')`),
  tiersCheck: check('plugin_install_policy_tiers_check', sql`
    ${table.allowedTiers} <@ ARRAY['official', 'verified', 'community', 'unverified']::TEXT[]
    AND ${table.requireApprovalTiers} <@ ARRAY['official', 'verified', 'community', 'unverified']::TEXT[]
    AND ${table.secretsAllowedTiers} <@ ARRAY['official', 'verified', 'community', 'unverified']::TEXT[]`),
}));

/**
 * Per-org plugin security notification settings (docs/plugin-publishing.md
 * "Scan gates"): who hears about a blocked build (N30) and a rescan finding
 * (N31), and where else they go. One row per org; absent = the column
 * defaults. The webhook secret and the external address are stored ENCRYPTED
 * (api-core secret-encryption, the org's key) and never returned; the address
 * is used only once confirmed through its emailed single-use link
 * (`external_verify_token_hash`, sha256 of the token).
 *
 * @table plugin_security_notification_prefs
 */
export const pluginSecurityNotificationPref = pgTable('plugin_security_notification_prefs', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  recipientMode: varchar('recipient_mode', { length: 10 }).$type<PluginSecurityRecipientMode>().default('writers').notNull(),
  targetUsers: text('target_users').array().$type<string[]>().default([]).notNull(),
  notifyRescan: boolean('notify_rescan').default(true).notNull(),
  digestMode: varchar('digest_mode', { length: 10 }).$type<PluginSecurityDigestMode>().default('immediate').notNull(),
  webhookUrl: varchar('webhook_url', { length: 2048 }),
  webhookSecret: text('webhook_secret'),
  externalEmailEnc: text('external_email_enc'),
  externalEmailHash: varchar('external_email_hash', { length: 64 }),
  externalEmailVerifiedAt: timestamp('external_email_verified_at', { withTimezone: true }),
  externalVerifyTokenHash: varchar('external_verify_token_hash', { length: 64 }),
  externalVerifyExpiresAt: timestamp('external_verify_expires_at', { withTimezone: true }),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  verifyTokenIdx: uniqueIndex('plugin_security_notification_prefs_verify_token_idx').on(table.externalVerifyTokenHash),
  recipientModeCheck: check('plugin_security_notification_prefs_recipient_mode_check',
    sql`${table.recipientMode} IN ('writers', 'users')`),
  digestModeCheck: check('plugin_security_notification_prefs_digest_mode_check',
    sql`${table.digestMode} IN ('immediate', 'daily', 'weekly')`),
}));

/**
 * N21 idempotency: one delivery per (advisory, installing org), so a retried
 * fan-out never notifies an org twice.
 *
 * @table plugin_advisory_deliveries
 */
export const pluginAdvisoryDelivery = pgTable('plugin_advisory_deliveries', {
  advisoryId: uuid('advisory_id').notNull().references(() => pluginAdvisory.id, { onDelete: 'cascade' }),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.advisoryId, table.orgId] }),
  orgIdx: index('plugin_advisory_delivery_org_idx').on(table.orgId),
}));

// ---------------------------------------------------------------------------
// Public read path — views created by postgres-init.sql
// ---------------------------------------------------------------------------

/**
 * `public_listings`: listed and unmaintained listings of non-suspended
 * publishers, public columns only, joined with the publisher's handle/name/tier and the stats.
 * Read as `ecosystem_public_reader` (see postgres-init.sql).
 */
export const publicListings = pgView('public_listings', {
  id: uuid('id').notNull(),
  publisherHandle: varchar('publisher_handle', { length: 39 }).notNull(),
  publisherDisplayName: varchar('publisher_display_name', { length: 255 }).notNull(),
  publisherTier: varchar('publisher_tier', { length: 20 }).$type<PublisherTier>().notNull(),
  publisherVerifiedAt: timestamp('publisher_verified_at', { withTimezone: true }),
  name: varchar('name', { length: 255 }).notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  summary: varchar('summary', { length: 300 }),
  description: text('description'),
  readmeHtml: text('readme_html'),
  license: varchar('license', { length: 64 }),
  homepageUrl: varchar('homepage_url', { length: 2048 }),
  sourceUrl: varchar('source_url', { length: 2048 }),
  icon: jsonb('icon').$type<PluginIcon>(),
  uploadedIcon: jsonb('uploaded_icon').$type<PluginUploadedIcon>(),
  keywords: jsonb('keywords').$type<string[]>().notNull(),
  featured: boolean('featured').notNull(),
  latestVersion: varchar('latest_version', { length: 50 }),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  searchVector: tsvector('search_vector'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  ratingBayes: doublePrecision('rating_bayes'),
  ratingCount: integer('rating_count').notNull(),
  ratingDist: jsonb('rating_dist').$type<Record<string, number>>(),
  recentRating: doublePrecision('recent_rating'),
  installCount: integer('install_count').notNull(),
  // NULL below the 5-org display threshold.
  activeOrgCount: integer('active_org_count'),
  successRate30d: doublePrecision('success_rate_30d'),
  healthScore: doublePrecision('health_score'),
  // 'listed' | 'unmaintained' — unmaintained stays public with a banner.
  state: varchar('state', { length: 20 }).$type<ListingState>().notNull(),
  healthBreakdown: jsonb('health_breakdown').$type<HealthBreakdown>(),
}).existing();

/**
 * `public_listed_versions`: non-paused versions of listed listings (yanked ones
 * included, flagged), with only the public subset of the frozen spec.
 */
export const publicListedVersions = pgView('public_listed_versions', {
  id: uuid('id').notNull(),
  listingId: uuid('listing_id').notNull(),
  publisherHandle: varchar('publisher_handle', { length: 39 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  imageDigest: varchar('image_digest', { length: 71 }),
  imageRepository: varchar('image_repository', { length: 512 }),
  breaking: boolean('breaking').notNull(),
  deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
  changelog: text('changelog'),
  vulnCritical: integer('vuln_critical'),
  vulnHigh: integer('vuln_high'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  pluginType: text('plugin_type'),
  computeType: text('compute_type'),
  secrets: jsonb('secrets').$type<PluginSecret[]>(),
  requiredMetadata: jsonb('required_metadata').$type<string[]>(),
  requiredVars: jsonb('required_vars').$type<string[]>(),
  networkEgress: jsonb('network_egress').$type<string[]>(),
  runAsRoot: boolean('run_as_root'),
  license: text('license'),
  readmeHtml: text('readme_html'),
  // Yanked versions stay listed (marked); the yank reason isn't public.
  yanked: boolean('yanked').notNull(),
  deprecationMessage: text('deprecation_message'),
  imageSource: text('image_source'),
  baseImageCreatedAt: timestamp('base_image_created_at', { withTimezone: true }),
  // Appended in the view (CREATE OR REPLACE VIEW only adds columns at the end).
  vulnCriticalFixable: integer('vuln_critical_fixable'),
  vulnHighFixable: integer('vuln_high_fixable'),
  scanFlaggedAt: timestamp('scan_flagged_at', { withTimezone: true }),
}).existing();

/**
 * `public_advisories`: PUBLISHED advisories on listed listings, public columns
 * only (no publisher/org ids, no author, no drafts or withdrawn rows).
 */
export const publicAdvisories = pgView('public_advisories', {
  id: uuid('id').notNull(),
  listingId: uuid('listing_id').notNull(),
  publisherHandle: varchar('publisher_handle', { length: 39 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  severity: varchar('severity', { length: 10 }).$type<AdvisorySeverity>().notNull(),
  summary: varchar('summary', { length: 300 }).notNull(),
  detailsHtml: text('details_html'),
  cveIds: text('cve_ids').array().notNull(),
  affectedRange: varchar('affected_range', { length: 255 }).notNull(),
  fixedVersion: varchar('fixed_version', { length: 50 }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}).existing();

/**
 * `public_reviews`: PUBLISHED reviews of public (non-paused) listings, public
 * columns only — the author's display name, never a user or org id —
 * with the publisher's reply.
 */
export const publicReviews = pgView('public_reviews', {
  id: uuid('id').notNull(),
  listingId: uuid('listing_id').notNull(),
  publisherHandle: varchar('publisher_handle', { length: 39 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  version: varchar('version', { length: 50 }),
  rating: smallint('rating').notNull(),
  title: varchar('title', { length: 120 }),
  bodyHtml: text('body_html'),
  authorDisplayName: varchar('author_display_name', { length: 100 }),
  verifiedUse: boolean('verified_use').notNull(),
  helpfulCount: integer('helpful_count').notNull(),
  edited: boolean('edited').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  publisherDisplayName: varchar('publisher_display_name', { length: 255 }).notNull(),
  replyBodyHtml: text('reply_body_html'),
  replyCreatedAt: timestamp('reply_created_at', { withTimezone: true }),
  replyUpdatedAt: timestamp('reply_updated_at', { withTimezone: true }),
}).existing();

/** The official publisher's handle (the system org's catalog). */
export const OFFICIAL_PUBLISHER_HANDLE = 'pipeline-builder';
/** The platform-owned publisher anonymous submissions land under. */
export const COMMUNITY_PUBLISHER_HANDLE = 'community';

/** Fixed ids of the two auto-approval rules postgres-init.sql seeds. */
export const SEEDED_AUTO_APPROVAL_RULE_IDS = {
  verifiedUpdates: '00000000-0000-4000-8000-00000000a001',
  officialCatalog: '00000000-0000-4000-8000-00000000a002',
} as const;

/**
 * TypeScript types representing database rows
 */
export type Publisher = typeof publisher.$inferSelect;
export type PublisherInsert = typeof publisher.$inferInsert;

export type PluginListing = typeof pluginListing.$inferSelect;
export type PluginListingInsert = typeof pluginListing.$inferInsert;

export type PluginListingVersion = typeof pluginListingVersion.$inferSelect;
export type PluginListingVersionInsert = typeof pluginListingVersion.$inferInsert;

export type PluginAdvisory = typeof pluginAdvisory.$inferSelect;
export type PluginAdvisoryInsert = typeof pluginAdvisory.$inferInsert;

export type EcosystemAutoApprovalRule = typeof ecosystemAutoApprovalRule.$inferSelect;
export type EcosystemAutoApprovalRuleInsert = typeof ecosystemAutoApprovalRule.$inferInsert;

export type PluginPublishRequest = typeof pluginPublishRequest.$inferSelect;
export type PluginPublishRequestInsert = typeof pluginPublishRequest.$inferInsert;

export type EcosystemReservedName = typeof ecosystemReservedName.$inferSelect;
export type EcosystemReservedNameInsert = typeof ecosystemReservedName.$inferInsert;

export type EcosystemSetting = typeof ecosystemSetting.$inferSelect;
export type EcosystemSettingInsert = typeof ecosystemSetting.$inferInsert;

export type EcosystemCollection = typeof ecosystemCollection.$inferSelect;
export type EcosystemCollectionInsert = typeof ecosystemCollection.$inferInsert;

export type PluginReview = typeof pluginReview.$inferSelect;
export type PluginReviewInsert = typeof pluginReview.$inferInsert;

export type PluginReviewReply = typeof pluginReviewReply.$inferSelect;
export type PluginReviewReplyInsert = typeof pluginReviewReply.$inferInsert;

export type PluginReviewReport = typeof pluginReviewReport.$inferSelect;
export type PluginReviewReportInsert = typeof pluginReviewReport.$inferInsert;

export type PluginReviewVote = typeof pluginReviewVote.$inferSelect;
export type PluginReviewVoteInsert = typeof pluginReviewVote.$inferInsert;

export type PluginReviewHistory = typeof pluginReviewHistory.$inferSelect;
export type PluginReviewHistoryInsert = typeof pluginReviewHistory.$inferInsert;

export type PluginStats = typeof pluginStats.$inferSelect;
export type PluginStatsInsert = typeof pluginStats.$inferInsert;

export type PluginSubmission = typeof pluginSubmission.$inferSelect;
export type PluginSubmissionInsert = typeof pluginSubmission.$inferInsert;

export type EcosystemSearchMiss = typeof ecosystemSearchMiss.$inferSelect;
export type EcosystemSearchMissInsert = typeof ecosystemSearchMiss.$inferInsert;

export type EcosystemNotification = typeof ecosystemNotificationQueue.$inferSelect;
export type EcosystemNotificationInsert = typeof ecosystemNotificationQueue.$inferInsert;

export type PipelineStepManifest = typeof pipelineStepManifest.$inferSelect;
export type PipelineStepManifestInsert = typeof pipelineStepManifest.$inferInsert;

export type PluginInstall = typeof pluginInstall.$inferSelect;
export type PluginInstallInsert = typeof pluginInstall.$inferInsert;

export type PluginInstallPolicy = typeof pluginInstallPolicy.$inferSelect;
export type PluginInstallPolicyInsert = typeof pluginInstallPolicy.$inferInsert;

export type PluginSecurityNotificationPref = typeof pluginSecurityNotificationPref.$inferSelect;
export type PluginSecurityNotificationPrefInsert = typeof pluginSecurityNotificationPref.$inferInsert;

export type PluginAdvisoryDelivery = typeof pluginAdvisoryDelivery.$inferSelect;
export type PluginAdvisoryDeliveryInsert = typeof pluginAdvisoryDelivery.$inferInsert;

export type PublicListing = typeof publicListings.$inferSelect;
export type PublicListedVersion = typeof publicListedVersions.$inferSelect;
export type PublicAdvisory = typeof publicAdvisories.$inferSelect;
export type PublicReview = typeof publicReviews.$inferSelect;

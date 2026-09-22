// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem types:
 * publishers, listings, publish requests and the Ecosystem console's queue,
 * review diff and auto-approval rules. Mirrors the plugin service's ecosystem API.
 */

import type { PluginCatalogEdits, PluginCatalogField, MetadataSource } from './index';
import type { SubmissionModerationView } from './plugin-submissions';
import type { HealthBreakdown } from '@/lib/public-directory/types';

import type {
  AdvisorySeverity, AdvisorySource, AdvisoryState, ListingState, PublisherTier, PublishRequestKind, PublishRequestLane,
  PublishRequestStatus,
} from '@pipeline-builder/api-core';

export type {
  AdvisorySeverity, AdvisorySource, AdvisoryState, ListingState, PublisherTier, PublishRequestKind, PublishRequestLane,
  PublishRequestStatus,
};

export interface Publisher {
  id: string;
  handle: string;
  displayName: string;
  description: string | null;
  homepageUrl: string | null;
  tier: PublisherTier;
  verifiedAt: string | null;
  verifiedGraceUntil: string | null;
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  suspendedAt: string | null;
  suspendReason: string | null;
  ownerOrgId: string | null;
  /** Roll-ups: install-weighted mean health of its live listings, and the run-weighted 30-day success rate. */
  healthScore?: number | null;
  successRate30d?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListingVersionView {
  id: string;
  version: string;
  imageDigest: string | null;
  imageRepository: string | null;
  breaking: boolean;
  pausedAt: string | null;
  yankedAt: string | null;
  yankReason: string | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  scannedAt?: string | null;
  /** The base image's `created` time, recorded at publish (the health score's freshness signal). */
  baseImageCreatedAt?: string | null;
  publishedAt: string;
  changelog: string | null;
  /** Deprecated: still resolves, with a warning carrying the message. */
  deprecatedAt: string | null;
  deprecationMessage: string | null;
}

export interface ListingView {
  id: string;
  publisherId: string;
  publisherHandle: string;
  publisherTier: PublisherTier;
  name: string;
  category: string;
  summary: string | null;
  description: string | null;
  license: string | null;
  homepageUrl: string | null;
  sourceUrl: string | null;
  icon: { key: string; badge?: string } | null;
  keywords: string[];
  state: ListingState;
  pausedAt: string | null;
  featured: boolean;
  latestVersion: string | null;
  createdAt: string;
  updatedAt: string;
  versions?: ListingVersionView[];
  openRequests?: number;
  /** 0–100 health score and its per-signal breakdown, where the view carries stats. */
  healthScore?: number | null;
  healthBreakdown?: HealthBreakdown | null;
}

/** One listing on the publisher Insights tab (GET /plugins/publisher/insights). */
export interface PublisherListingInsight {
  listingId: string;
  name: string;
  state: ListingState;
  paused: boolean;
  latestVersion: string | null;
  installCount: number;
  /** k-anonymous: `count` is null and `label` is "<5" below five orgs. */
  activeOrgs: { count: number | null; label: string };
  successRate30d: number | null;
  healthScore: number | null;
  healthBreakdown: HealthBreakdown | null;
  rating: { score: number; count: number } | null;
  /** Monthly average of published reviews, oldest month first (12 months). */
  ratingTrend: Array<{ month: string; average: number | null; count: number }>;
  openReviewReports: number;
  openAdvisories: number;
  statsUpdatedAt: string | null;
}

export interface PublisherInsights {
  publisher: {
    handle: string;
    displayName: string;
    tier: PublisherTier;
    healthScore: number | null;
    successRate30d: number | null;
  } | null;
  listings: PublisherListingInsight[];
}

/** `payload` of a publish request — only the keys the UI reads are typed. */
export interface PublishRequestPayload {
  name?: string;
  version?: string;
  metadata?: {
    values?: Partial<Record<PluginCatalogField, unknown>>;
    sources?: Partial<Record<PluginCatalogField, MetadataSource>>;
  };
  breaking?: boolean;
  bootstrap?: boolean;
  target?: { handle?: string; displayName?: string; listingId?: string; targetPublisherHandle?: string };
  transfer?: {
    targetPublisherId: string;
    targetOrgId: string;
    response: 'pending' | 'accepted' | 'declined';
    respondedBy?: string;
    respondedAt?: string;
  };
  application?: { domain?: string; notes?: string };
  /** A Verified application's eligibility, as checked when it was submitted. */
  eligibility?: VerifiedEligibility;
  action?: 'unyank' | 'unsuspend_publisher' | 'relist' | 'tier_verified';
  /** `advisory` requests: the draft being published. */
  advisoryId?: string;
  severity?: AdvisorySeverity;
  summary?: string;
  affectedRange?: string;
  submitter?: { principalType: 'user' | 'service_account'; name?: string };
  /** `submission` requests: the quarantined submission, and whether it creates the listing. */
  submissionId?: string;
  newListing?: boolean;
  [key: string]: unknown;
}

export interface PublishRequestView {
  id: string;
  kind: PublishRequestKind;
  status: PublishRequestStatus;
  lane: PublishRequestLane;
  publisherId: string;
  publisherHandle: string;
  publisherTier: PublisherTier;
  listingId: string | null;
  listingName: string | null;
  pluginId: string | null;
  version: string | null;
  digest: string | null;
  payload: PublishRequestPayload;
  submittedBy: string;
  submittedOrgId: string | null;
  submittedAt: string;
  firstApprovedBy: string | null;
  secondApprovedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  autoRuleId: string | null;
  securityFixAdvisoryId: string | null;
}

export interface ListingsQuota {
  used: number;
  /** -1 = unlimited. */
  limit: number;
}

export interface PublisherTerms {
  currentVersion: string;
  accepted: boolean;
}

/** `GET /plugins/publisher`. */
export interface PublisherContext {
  publisher: Publisher | null;
  isRootOrg: boolean;
  terms: PublisherTerms;
  verifiedEligible: boolean;
  listingsQuota: ListingsQuota;
  publishingEnabled: boolean;
}

export type PublishGateId = 'publisher' | 'terms' | 'visibility' | 'license' | 'readme' | 'signed' | 'scanned'
  | 'vuln' | 'quota' | 'listing_state' | 'already_listed' | 'name';

export interface PublishGate {
  id: PublishGateId | string;
  ok: boolean;
  message: string;
}

export interface DraftMetadataField {
  field: PluginCatalogField;
  value: unknown;
  source: MetadataSource | null;
  /** The live listing's value (new_version only). */
  current?: unknown;
  /** new_version: the detected value differs from the live listing. */
  changed?: boolean;
}

export interface ListingUpdateOfferField {
  field: PluginCatalogField;
  value: unknown;
  current: unknown;
}

/** `GET /plugins/publish-requests/draft?pluginId=`. */
export interface PublishDraft {
  kind: 'new_listing' | 'new_version';
  plugin: {
    id: string;
    name: string;
    version: string;
    visibility: string;
    imageDigest: string | null;
    license: string | null;
    hasReadme: boolean;
    signed: boolean;
    scannedAt: string | null;
    vulnCritical: number | null;
    vulnHigh: number | null;
    breaking: boolean;
  };
  listing: ListingView | null;
  gates: PublishGate[];
  metadata: DraftMetadataField[];
  listingUpdateOffer: ListingUpdateOfferField[];
  publisher: Publisher | null;
  listingsQuota: ListingsQuota;
  terms: PublisherTerms;
}

export type PublishRequestBody =
  | { kind: 'new_listing'; pluginId: string; metadata?: PluginCatalogEdits; securityFixAdvisoryId?: string }
  | { kind: 'new_version'; pluginId: string; securityFixAdvisoryId?: string; breaking?: boolean }
  | {
    kind: 'listing_update';
    listingId: string;
    metadata: PluginCatalogEdits;
    /** Provenance of ACCEPTED detected values; omitted fields default to `user` (edited). */
    sources?: Partial<Record<PluginCatalogField, MetadataSource>>;
  }
  | { kind: 'yank'; listingId: string; version: string; reason: string }
  | { kind: 'unpause'; listingId: string; version?: string; reason?: string }
  | { kind: 'transfer'; listingId: string; target: { targetPublisherHandle: string }; reason?: string }
  | { kind: 'claim'; target: { handle: string } | { listingId: string }; reason?: string }
  | { kind: 'profile_change'; target: { handle?: string; displayName?: string }; reason?: string }
  | { kind: 'verify'; application: { domain?: string; notes?: string } }
  | { kind: 'advisory'; listingId: string; advisory: AdvisoryInput };

// ---------------------------------------------------------------------------
// Security advisories (an org's consumption policy can block on them: `blockOnAdvisory`)
// ---------------------------------------------------------------------------


/** The editable fields of an advisory (a publisher's request, or a moderator's draft). */
export interface AdvisoryInput {
  /** A semver range, e.g. `>=1.0.0 <1.4.2`. */
  affectedRange: string;
  severity: AdvisorySeverity;
  /** At most 300 characters. */
  summary: string;
  /** Raw markdown — only ever edited, never rendered (render `detailsHtml`). */
  detailsMd?: string | null;
  cveIds?: string[];
  fixedVersion?: string | null;
}

export interface AdvisoryView {
  id: string;
  listingId: string;
  listingName: string;
  publisherHandle: string;
  affectedRange: string;
  fixedVersion: string | null;
  severity: AdvisorySeverity;
  summary: string;
  detailsMd: string | null;
  /** Server-sanitized HTML. */
  detailsHtml: string | null;
  cveIds: string[];
  state: AdvisoryState;
  source: AdvisorySource;
  createdBy: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The OPEN `advisory` publish request for a draft (null once decided). */
  requestId: string | null;
  /** The listing's published versions the range covers. */
  affectedVersions: string[];
}

// ---------------------------------------------------------------------------
// Ecosystem console (system org)
// ---------------------------------------------------------------------------

export type EcosystemDecisionPermission = 'plugins:moderate' | 'publishers:verify';

export interface QueueItem extends PublishRequestView {
  ageHours: number;
  slaHours: number;
  slaBreached: boolean;
  requiresTwoPerson: boolean;
  requiresStepUp: boolean;
  requiredPermission: EcosystemDecisionPermission;
  /** The CALLER may not decide it (own org / own upload / first approver). */
  conflictOfInterest: boolean;
  conflictReason: string | null;
}

export interface AddedRemoved { added: string[]; removed: string[] }

export interface ReviewDiff {
  previousVersion: string | null;
  metadata: Array<{
    field: PluginCatalogField;
    value: unknown;
    previous: unknown;
    source: MetadataSource | null;
    changed: boolean;
    userEdited: boolean;
    isLink: boolean;
    /** A user-edited link — the phishing check. */
    highlight: boolean;
  }>;
  contract: {
    secrets: AddedRemoved;
    egress: AddedRemoved;
    requiredMetadata: AddedRemoved;
    requiredVars: AddedRemoved;
    env: AddedRemoved & { changed: string[] };
    commands: { previous: string[]; current: string[]; changed: boolean };
    installCommands: { previous: string[]; current: string[]; changed: boolean };
    runAsRoot: { previous: boolean | null; current: boolean | null; regression: boolean };
    pluginType: { previous: string | null; current: string | null };
    computeType: { previous: string | null; current: string | null };
  } | null;
  vuln: {
    previous: { critical: number | null; high: number | null } | null;
    current: { critical: number | null; high: number | null; scannedAt: string | null };
    newCritical: number;
    newHigh: number;
  } | null;
  dockerfile: { previous: string | null; current: string | null; changed: boolean } | null;
  sbom: { added: string[]; removed: string[]; error: string | null } | null;
  icon: { previous: unknown; current: unknown; changed: boolean; curatedMark: boolean } | null;
  gates: PublishGate[];
  publisherHistory: { tier: PublisherTier; createdAt: string; listings: number; approved: number; rejected: number };
  autoApproval: {
    eligible: boolean;
    ruleId: string | null;
    ruleName: string | null;
    reasons: string[];
    /** The version bump against the previous listed version. */
    bump?: string;
    /** The bootstrap exception is still open (fresh install, zero listings). */
    bootstrapOpen?: boolean;
  };
}

export interface ResignJob {
  scope: 'publisher' | 'listing';
  id: string;
  reason: string;
  done: number;
  createdAt: string;
}

/** One automatic Verified-eligibility check. `ok: null` = platform couldn't answer. */
export type VerifiedCheckId = 'plan' | 'domain' | 'owner_mfa';
export interface VerifiedCheck {
  id: VerifiedCheckId;
  ok: boolean | null;
  detail: string;
}

/** The three checks a Verified application must pass, at application and decision time. */
export interface VerifiedEligibility {
  eligible: boolean;
  checkedAt: string;
  checks: VerifiedCheck[];
  verifiedDomains: string[];
}

/** How many people could decide (counts only). */
export interface ApproverCount {
  /** System-org holders of the permission (Ecosystem Managers). */
  holders: number;
  /** Holders left after conflicts of interest. */
  eligible: number;
  /** Superadmins not excluded — they may always act as the second approver. */
  superadmins: number;
}

/** An approver count with the staffing floors applied. `count: null` = unknown. */
export interface ApproverStanding {
  permission: 'plugins:moderate' | 'publishers:verify';
  count: ApproverCount | null;
  /** Fewer holders than the staffing minimum (3). */
  belowMinimum: boolean;
  /** Fewer eligible approvers than two-person approval needs (2). */
  belowTwoPerson: boolean;
}

export interface EcosystemApprovers {
  minimum: number;
  twoPersonMinimum: number;
  moderate: ApproverStanding;
  verify: ApproverStanding;
}

/** `GET /plugins/ecosystem/requests/:id`. */
export interface EcosystemRequestDetail {
  request: QueueItem;
  review: ReviewDiff;
  /** Who could still decide it, minus the requester's conflicts (null once decided). */
  approvers: ApproverStanding | null;
  /** A LIVE re-check of an open Verified application (null for other kinds). */
  eligibility: VerifiedEligibility | null;
  /**
   * `submission` requests: the gate report, heuristics, quarantine image
   * and scans. Read through `normalizeSubmissionModeration`, which also takes
   * the server's raw `{ gateReport: { gates, facts }, heuristics: { findings } }`.
   */
  submission?: SubmissionModerationView | Record<string, unknown> | null;
  /**
   * `claim` requests on a `community` listing: does the claimer's
   * verified email match the listing's approving submission? null = not a
   * community listing / unknown.
   */
  claimEmailMatch?: boolean | null;
}

/** A reserved handle / listing name (`GET /plugins/ecosystem/reserved-names`). */
export interface ReservedName {
  name: string;
  reason: string | null;
  /** Reserved FOR this publisher (claimable by it alone); null = refused to everyone. */
  publisherId: string | null;
  createdAt: string;
}

/** `GET /plugins/ecosystem/overview`. */
export interface EcosystemOverview {
  /** Ecosystem Manager headcount per decision permission (no conflicts applied). */
  approvers: EcosystemApprovers;
  pending: { standard: number; security: number; secondApproval: number; verify: number };
  bootstrap: {
    state: 'open' | 'closed' | 'never_opened';
    openedAt: string | null;
    closedAt: string | null;
    reason: string | null;
    /** Requests approved under the bootstrap exception. */
    approved?: number;
  };
  officialAutoApprovalEnabled: boolean;
  termsVersion: string;
  /** The service account the Official catalog loader submits as. */
  officialLoaderAccount?: string;
  /** Trust re-sign jobs (tier / listing-state changes re-annotating images). */
  resignJobs?: ResignJob[];  /** Review moderation queue sizes. */
  reviews: { held: number; reported: number };
}

/** Queue `status` filter: a real status, `open` (pending + second approval), `auto`
 *  (approved by a rule) or `decided` (approved + rejected + withdrawn). */
export type QueueStatusFilter = PublishRequestStatus | 'open' | 'auto' | 'decided';

export type EcosystemPublisher = Publisher & { listingCount: number };

export interface AutoRuleConditions {
  requestKinds: Array<'new_version' | 'listing_update'>;
  publisherTiers: PublisherTier[];
  bumps: Array<'patch' | 'minor'>;
  submitterServiceAccount?: string;
  textOnlyListingUpdates?: boolean;
  maxPerListingPerDay?: number;
  maxPerDay?: number;
  instanceFlag?: 'OFFICIAL_AUTO_APPROVAL_ENABLED';
  /** Marks a seeded rule (its seed key). */
  seeded?: string;
}

export interface AutoRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: AutoRuleConditions;
  createdBy: string;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  pendingChange: {
    requestedBy: string;
    requestedAt: string;
    enabled: boolean;
    name: string;
    conditions: AutoRuleConditions;
  } | null;
  seeded: boolean;
  approvedToday: number;
  flagDisabled: boolean;
}

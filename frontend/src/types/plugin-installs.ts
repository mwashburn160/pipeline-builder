// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin installs and the org consumption policy (docs/plans/plugin-ecosystem.md
 * §3.1 D16, §3.2, §3.4, §3.5 — workstream W2). Mirrors the plugin service's
 * install routes.
 *
 * Official listings reach every org as IMPLICIT installs (virtual, no row:
 * `id: null`, `implicit: true`). Everything from other orgs resolves only
 * through an install. Own-org plugins still come from `GET /plugins`.
 */

import type { AdvisorySeverity, EcosystemListingState, PublisherTier } from './ecosystem';

export type VersionPolicy = 'pinned' | 'patch' | 'minor' | 'latest';
export type InstallStatus = 'active' | 'pending_approval' | 'denied';
export type BlockOnAdvisory = 'critical' | 'high' | 'never';
export type OfficialInstalls = 'implicit' | 'explicit';

export interface BlockedInfo {
  reason: 'tier' | 'blocked_listing' | 'advisory' | 'suspended';
  message: string;
}

export type InstallWarningCode = 'PLUGIN_ADVISORY' | 'PLUGIN_DEPRECATED' | 'LISTING_UNMAINTAINED' | 'PLUGIN_SECRETS_WITHHELD';

export interface InstallWarning {
  code: InstallWarningCode;
  message: string;
}

export interface InstallAdvisory {
  id: string;
  severity: AdvisorySeverity;
  summary: string;
  fixedVersion: string | null;
  blocking: boolean;
}

export interface InstallUpgrade {
  version: string;
  breaking: boolean;
  changelog: string | null;
  vulnDelta: { newCritical: number; newHigh: number };
}

export interface InstallView {
  /** `null` = the implicit Official install (virtual, D16). */
  id: string | null;
  listingId: string;
  publisherHandle: string;
  publisherDisplayName: string;
  publisherTier: PublisherTier;
  name: string;
  summary: string | null;
  category: string;
  icon: unknown | null;
  state: EcosystemListingState;
  paused: boolean;
  versionPolicy: VersionPolicy;
  /** The install's baseline version (null for implicit). */
  pinnedVersion: string | null;
  /** What a new synth resolves to now (null when nothing resolves). */
  resolvedVersion: string | null;
  latestVersion: string | null;
  status: InstallStatus;
  implicit: boolean;
  /** Comes from the root org (the caller is a team). */
  inherited: boolean;
  installedBy: string | null;
  approvedBy: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  /** The newest version OUTSIDE the policy range. */
  upgrade: InstallUpgrade | null;
  blocked: BlockedInfo | null;
  /** Warnings for the version it resolves to (W8). */
  warnings: InstallWarning[];
  /** Published advisories covering the resolved version — or, when resolution is
   *  blocked by an advisory, the blocking ones (`blocking: true`). */
  advisories: InstallAdvisory[];
  /** Present on the installs LIST (`GET /plugins/installs`): as
   *  {@link CatalogEntry.needsApproval}. */
  needsApproval?: boolean;
  /** A requested version / policy change waiting for an approver. */
  pendingChange?: InstallPendingChange | null;
}

export interface ConsumptionPolicy {
  allowedTiers: PublisherTier[];
  requireApprovalTiers: PublisherTier[];
  secretsAllowedTiers: PublisherTier[];
  blockOnAdvisory: BlockOnAdvisory;
  officialInstalls: OfficialInstalls;
  blockedListings: Array<{ publisher: string; name: string }>;
}

export interface ListingSummary {
  id: string;
  publisherHandle: string;
  publisherDisplayName: string;
  publisherTier: PublisherTier;
  name: string;
  summary: string | null;
  category: string;
  icon: unknown | null;
  latestVersion: string | null;
  state: string;
  paused: boolean;
  license: string | null;
}

/** The version an unversioned reference resolves to for this org. */
export interface ResolvedVersionInfo {
  version: string;
  pluginType: string | null;
  computeType: string | null;
  primaryOutputDirectory: string | null;
  description: string | null;
  requiredMetadata: string[];
  requiredVars: string[];
  secrets: string[];
}

/** The pipeline reference to write for a listing. */
export interface PluginReference {
  publisher?: string;
  name: string;
}

export interface CatalogEntry {
  listing: ListingSummary;
  install: InstallView | null;
  /** May this org install it now (not blocked, not paused, not already installed). */
  installable: boolean;
  /** Installing it would create a pending request. */
  requiresApproval: boolean;
  /** Moving this install across a major/breaking version, or its policy to
   *  `latest`, needs an approver (`plugin_installs:manage`) for this caller —
   *  the server refuses it otherwise. */
  needsApproval: boolean;
  blocked: BlockedInfo | null;
  /** Null when not installed / nothing resolves. */
  resolved: ResolvedVersionInfo | null;
  reference: PluginReference;
  /** An own-org plugin of the same name wins for unqualified refs. */
  shadowedBy: { pluginIds: string[] } | null;  /** Bayesian review score and vote count; null when unrated. */
  rating: { score: number; count: number } | null;
  installCount: number;
}

export interface ListingVersionState {
  version: string;
  breaking: boolean;
  yanked: boolean;
  paused: boolean;
  deprecated: boolean;
  publishedAt: string;
  changelog: string | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
}

/** `GET /plugins/listings/:publisher/:name/install-state`. */
export interface InstallState {
  entry: CatalogEntry;
  versions: ListingVersionState[];
  /** Holds `plugins:install`. */
  canInstall: boolean;
  /** Holds `plugin_installs:manage`. */
  canManage: boolean;
}

/** `GET|PUT /plugins/install-policy`. */
export interface InstallPolicyResponse {
  policy: ConsumptionPolicy;
  effective: ConsumptionPolicy;
  inheritsFromRoot: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  canEdit: boolean;
}

export interface ShadowingEntry {
  name: string;
  pluginIds: string[];
  listing: { publisherHandle: string; name: string; publisherTier: PublisherTier };
}

export type InstallStatusFilter = InstallStatus | 'all';

export interface CreateInstallBody {
  publisher: string;
  name: string;
  versionPolicy?: VersionPolicy;
  version?: string;
}

export interface UpdateInstallBody {
  versionPolicy?: VersionPolicy;
  version?: string;
}

/** An install change waiting for an approver (`plugin_installs:manage`). */
export interface InstallPendingChange {
  version: string;
  versionPolicy: VersionPolicy;
  requestedBy: string;
  requestedAt: string;
  note: string | null;
}

/** A pending install change as the change-request routes show it. */
export interface InstallChangeRequestView {
  installId: string;
  /** `publisher/name`. */
  listing: string;
  from: { version: string | null; versionPolicy: VersionPolicy };
  to: { version: string; versionPolicy: VersionPolicy };
  requestedBy: string;
  requestedAt: string;
  note: string | null;
}

export interface InstallChangeRequestBody extends UpdateInstallBody {
  note?: string;
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The org and the people in it: membership, roles, preferences, quota and the
 *  invitations that add to it. */

import type { Criticality, EntityLink, Lifecycle, OwnerType, QuotaTier, QuotaType, RoleGrant, TemplateInput, Visibility } from '@pipeline-builder/api-core';

/** The current user's preferences for the active organization (`/user/preferences`). */
export interface UserPreferences {
  favorites: string[];
  recents: string[];
  notifications: {
    /** Hide the quota banner while usage is only nearing a limit. */
    muteQuotaWarnings: boolean;
    /** Plugin-ecosystem EMAIL opt-outs. In-app messages are always
     *  delivered, and transactional / security notices ignore these. */
    ecosystem: EcosystemNotificationPrefs;
  };
}

/** Per-user ecosystem email preferences (`ecosystem.*.email`), all default on. */
export interface EcosystemNotificationPrefs {
  /** `ecosystem.reviews.email` — new reviews on your listings, replies to your review. */
  reviewsEmail: boolean;
  /** `ecosystem.upgrades.email` — new versions & auto-updates (weekly digest), deprecations. */
  upgradesEmail: boolean;
  /** `ecosystem.installs.email` — install requests and install decisions. */
  installsEmail: boolean;
  /** `ecosystem.moderationDigest.email` — daily moderation digest (system-org Ecosystem Managers). */
  moderationDigestEmail: boolean;
}

/** A user's membership in an organization. */
export interface UserOrgMembership {
  id: string;
  name: string;
  slug?: string;
  role: 'owner' | 'admin' | 'member';
  /** Parent org id when this org is a team (org → team hierarchy); absent for top-level orgs. */
  parentOrgId?: string;
  /** Parent org's display name (teams only) — names the parent when the user
   *  isn't a member of it, so the team can't pass for a top-level org. */
  parentOrgName?: string;
  /** No membership row: the user reaches this team as an admin of its parent
   *  (inherited authority). It isn't on the team's roster and uses no seat. */
  viaAncestor?: boolean;
  /** Org's quota tier — used to gate tier-gated actions (only team/enterprise roots may parent teams). */
  tier?: QuotaTier;
  /** Live teams nested under this org (0 for a flat org or a team). Read through
   *  `useOrgHierarchy` — it decides whether hierarchy surfaces render at all. */
  childOrgCount: number;
  /**
   * Names of the Roles the user holds in this org, sorted.
   *
   * This is what the switcher labels a row with. `role` is the coarse
   * owner/admin/member word, which grants nothing on its own — permissions come
   * only from Roles — so a row labelled from `role` names the one thing that is
   * not the answer to "what am I here?".
   *
   * Empty for an inherited-authority row (no membership, so no Roles) and for an
   * org whose Roles are not assigned yet; the switcher falls back to `role`.
   * Optional on the type because an older cached payload may not carry it.
   */
  roleNames?: string[];
  /** The org's `adminActionsRequireMfa` policy (its own or an ancestor's) would
   *  refuse an aal-1 session switching into it. */
  requiresMfa?: boolean;
}

/**
 * Organization member
 */
export interface OrganizationMember {
  id: string;
  username: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  isOwner: boolean;
  isActive: boolean;
  isEmailVerified: boolean;
  createdAt: string;
  updatedAt?: string;
  /** The permission Roles this member holds (id + name), embedded in the roster
   *  payload so chips render without an all-roles O(members×roles) client scan. */
  roles?: Array<{ id: string; name: string }>;
}

/**
 * A descendant team in the org → team hierarchy, annotated with whether a given
 * member belongs to it. Returned by `getMemberTeams` to power the admin
 * "manage teams" view (a member can be on multiple teams).
 */
export interface MemberTeam {
  orgId: string;
  orgName: string;
  parentOrgId?: string;
  isMember: boolean;
  role?: 'owner' | 'admin' | 'member';
  isActive?: boolean;
}


/**
 * A permission Role within an org, with its current members. Role membership
 * drives the cached org role: Administrators → org-admin, Superadmins (system
 * org only) → platform admin. Returned by `getOrganizationRoles`.
 */
export interface OrganizationRole {
  id: string;
  name: string;
  /** Operator-facing description (custom roles). */
  description?: string;
  grantsRole: RoleGrant;
  /** Fine-grained permissions this Role grants (empty for role-only Roles). */
  permissions: string[];
  /** Seeded default Role (Administrators / Developers / Superadmins) — these
   *  can't be edited or deleted from the UI; only their membership is editable.
   *  Custom, user-created Roles are fully editable. */
  system: boolean;
  members: Array<{ id: string; username: string; email: string }>;
}

/**
 * Quota summary per type (matches backend OrgQuotaResponse.quotas[type])
 */
export interface QuotaSummary {
  limit: number;
  used: number;
  remaining: number;
  unlimited: boolean;
  resetAt: string;
}

/**
 * The quota kinds the dashboard currently surfaces — a curated subset of the
 * backend's full `QuotaType` (which also tracks `storageBytes`, `dashboards`,
 * `alertRules`, `alertDestinations`, `idpConfigs`, `listings`). Key display/config maps by
 * {@link DisplayedQuotaType} so they needn't enumerate quota kinds the UI does
 * not render. The `satisfies` clause fails the build if any entry stops being a
 * valid `QuotaType`, so this list can't silently drift either.
 */
export const DISPLAYED_QUOTA_TYPES = [
  'plugins', 'pipelines', 'apiCalls', 'automationCalls', 'aiCalls',
] as const satisfies readonly QuotaType[];
export type DisplayedQuotaType = typeof DISPLAYED_QUOTA_TYPES[number];

/**
 * Unified org quota response (matches backend OrgQuotaResponse)
 */
export interface OrgQuotaResponse {
  orgId: string;
  name: string;
  slug: string;
  tier?: QuotaTier;
  quotas: Record<QuotaType, QuotaSummary>;
  /**
   * Length of the usage period in days (`QUOTA_RESET_DAYS`, default 3). Every
   * counter rolls over on this one period — never assume a month. The usage
   * forecast needs it and is simply not shown without it.
   */
  periodDays?: number;
  isDefault?: boolean;
  /**
   * Present when the org belongs to an org → team pool (a root with teams, or a
   * team). `quotas` (except storageBytes) and `tier` are then the ROOT's pooled
   * caps against the whole subtree's usage. Absent for a flat org.
   */
  pool?: {
    rootOrgId: string;
    /**
     * Display name of `rootOrgId`. The quota service emits `''` when it could
     * not read the root's row (`pooled-quota.ts`: `root?.name ?? ''`), and the
     * update / reset-usage responses carry no pool block at all — so this is
     * genuinely optional and callers must have human copy for its absence.
     * Never substitute `rootOrgId`: a UUID is not a name.
     */
    rootOrgName?: string;
    /** True when this org IS the pool root (false ⇒ a team). */
    isRoot: boolean;
    /** Root + every team in the pool. */
    orgCount: number;
  };
}

/** What a quota usage breakdown groups by. */
export type QuotaUsageGroupBy = 'principal' | 'route' | 'pipeline' | 'day';

/** Query for `GET /quotas/:orgId/usage`. `from`/`to` are ISO timestamps. */
export interface QuotaUsageParams {
  type?: QuotaType;
  groupBy?: QuotaUsageGroupBy;
  from?: string;
  to?: string;
}

/** One group of a usage breakdown. `net` = counted − refunded. */
export interface QuotaUsageGroup {
  /** Principal id, route pattern, pipeline id or `YYYY-MM-DD`; null = unattributed. */
  key: string | null;
  principalType?: 'user' | 'service_account' | 'service';
  keyCount?: number;
  counted: number;
  /** Attempts refused at the limit — the counter never moved for these. */
  denied: number;
  /** Requests SERVED past the limit (concurrent passes of the cached check) —
   *  not counted, since the counter never exceeds the limit. */
  overshoot: number;
  refunded: number;
  net: number;
}

/** `GET /quotas/:orgId/usage` response. */
export interface QuotaUsageBreakdown {
  orgId: string;
  type: QuotaType | null;
  groupBy: QuotaUsageGroupBy;
  from: string;
  to: string;
  /** How far back the ledger reaches. */
  retentionDays: number;
  groups: QuotaUsageGroup[];
}

/** An account's quota threshold-notice settings. */
export interface QuotaNoticeSettings {
  /** The account root the settings belong to. */
  orgId: string;
  enabled: boolean;
  webhookUrl: string | null;
  thresholds: number[];
  /** False when the deployment has switched notices off for everyone. */
  noticesEnabledOnInstance?: boolean;
}

/**
 * Organization model
 */
export interface Organization {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  ownerId: string;
  memberCount: number;
  /** Quota tier. Optional because some list endpoints elide it to keep
   *  payloads small. */
  tier?: QuotaTier;
  /** Sysadmin-facing facet flags set by the orgs list endpoint. Absent on
   *  rows returned by other endpoints (e.g. org-detail). */
  kmsConfigured?: boolean;
  idpConfigured?: boolean;
  /** Org → team hierarchy: parent org id when this org is a team (null/absent =
   *  root), and the parent's display name when resolvable. Set by the sysadmin
   *  orgs list endpoint. */
  parentOrgId?: string | null;
  parentOrgName?: string;
  quotas?: Record<QuotaType, QuotaSummary>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Organization AI provider configuration
 */
export interface AIProviderStatus {
  configured: boolean;
  hint?: string;
}

export interface OrgAIConfig {
  providers: Record<string, AIProviderStatus>;
  /**
   * The organization's AI switch. When an administrator turns it off every AI
   * entry point (Ask, pipeline/plugin generation, report summaries) refuses with
   * `AI_DISABLED` before any quota is reserved or provider contacted.
   */
  aiEnabled: boolean;
}

/**
 * Invitation model
 */
/**
 * What became of an invitation's email. `not-configured` is a real, common
 * state — a deployment with no mail transport — and the reason a boolean was
 * wrong: it reported those as sent, so the admin saw success and the invitee
 * got nothing. When it is not `sent`, the response carries a one-time
 * `acceptUrl` to hand over by other means.
 */
export type InvitationDelivery = 'sent' | 'not-configured' | 'failed';

export interface Invitation {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  /**
   * Names of the Roles this invitation assigns on acceptance, resolved by the
   * listing (the stored ids answer nothing in a review queue). Absent when it
   * grants only the coarse role, or when every named Role has since been
   * deleted — an acceptance would drop those too, so the queue must not promise
   * them.
   */
  roleNames?: string[];
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  inviterName: string;
  organizationId: string;
  organizationName: string;
  expiresAt: string;
  createdAt: string;
}

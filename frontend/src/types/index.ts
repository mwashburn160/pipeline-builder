// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Quota + tier identifiers come from the api-core source of truth (see below).
// `import type` is fully erased at build time, so this pulls no server-only
// runtime code into the Next bundle.
import type { QuotaType, QuotaTier, Visibility, Criticality, EntityLink, Lifecycle, OwnerType, TemplateInput } from '@pipeline-builder/api-core';

/**
 * User model.
 *
 * Users can belong to multiple organizations via {@link UserOrgMembership}.
 * The `role` here is the user's role in their **active** organization (from
 * the JWT), not a global role. Use `organizations` to see all memberships.
 * `organizationId` / `organizationName` reflect the currently active org.
 */
export interface User {
  id: string;
  username: string;
  email: string;
  /** Per-org role in the active organization. Derived from UserOrganization, not a global role. */
  role: 'owner' | 'admin' | 'member';
  /**
   * Global super-admin flag carried in the JWT. True for Pipeline Builder
   * operators; supersedes the legacy "is this user in the system org"
   * check. Only set when true to keep payloads small for the common case.
   */
  isSuperAdmin?: boolean;
  /** Active organization ID (user may belong to multiple orgs; see `organizations`) */
  organizationId?: string;
  /** Active organization name */
  organizationName?: string;
  isEmailVerified: boolean;
  /** First-run flag for social-signup users who never named their org / picked a
   *  plan. When true, the auth guard routes them to the onboarding screen. */
  needsOnboarding?: boolean;
  tier?: QuotaTier;
  features?: string[];
  /**
   * Effective fine-grained permissions for the active org (RBAC): the role's
   * base bundle ∪ any custom-group grants; superadmins get all. Client-visible
   * for UI gating only — every privileged action is re-checked server-side.
   */
  permissions?: string[];
  featureOverrides?: Record<string, boolean>;
  /** Which step-up factors this account has — drives what StepUpModal offers. */
  authFactors?: AuthFactors;
  /** The active org's two-factor requirement (#8). Present ONLY when the org
   *  actually requires MFA — absence is the common case, and is what keeps the
   *  banner quiet for everyone else. */
  mfaPolicy?: SessionMfaPolicy;
  /** All organizations this user belongs to, with per-org roles */
  organizations?: UserOrgMembership[];
  createdAt?: string;
  updatedAt?: string;
}

/** A sign-in provider the user can step up with by signing in again. */
export type ReauthProvider =
  | { type: 'oauth'; provider: string }
  | { type: 'sso'; provider: string; orgId: string; orgName?: string };

/** Step-up factors reported by GET /user/profile. */
export interface AuthFactors {
  hasPassword: boolean;
  /** Registered passkeys. Non-zero ⇒ the step-up modal offers "Use a passkey". */
  passkeyCount: number;
  /** A CONFIRMED authenticator-app enrolment ⇒ the modal offers "Enter a code". */
  hasTotp: boolean;
  providers: ReauthProvider[];
}

/**
 * What `GET /user/profile` says about the ACTIVE org's two-factor requirement
 * (#8), alongside the current session's own assurance level. Everything the
 * member-facing banner needs, in one place: whether the requirement is already
 * biting, when it starts to, and whether this session already satisfies it.
 */
export interface SessionMfaPolicy {
  /** Always true when present — the field is omitted for orgs with no policy. */
  requireMfa: true;
  /** The grace period has passed, so a single-factor session is now refused. */
  enforced: boolean;
  /** ISO deadline while a grace period is still running. */
  graceUntil?: string;
  /** This session's assurance level: 2 means it already meets the requirement. */
  aal: 1 | 2;
}

/**
 * An org's full two-factor policy, from `GET /organization/:id/mfa-policy`.
 * Distinct from {@link SessionMfaPolicy}: this is the ADMIN's view (what the org
 * has set and what it inherits), not one member's session state.
 */
export interface OrgMfaPolicy {
  requireMfa: boolean;
  enforced: boolean;
  /** This org's OWN setting, regardless of what a parent org imposes. */
  own: boolean;
  /** The org states its identity provider enforces MFA, which is what makes an
   *  SSO sign-in through it count as two-factor. */
  idpEnforcesMfa: boolean;
  graceUntil?: string;
  requiredSince?: string;
  /** Set when a PARENT org's requirement is what's in force here. */
  inheritedFrom?: string;
  /** Grace period offered by default when turning the requirement on. */
  defaultGraceDays: number;
  /**
   * How many active members already hold a passkey or an authenticator app —
   * the number that makes "14 days" a decision rather than a guess. Present on
   * the policy READ; a write response carries the policy alone.
   */
  enrolment?: { members: number; enrolled: number };
}

/** The account's authenticator-app state, from GET /auth/totp/status. */
export interface TotpStatus {
  /** Confirmed and in force — sign-in now asks for a code. */
  enabled: boolean;
  /** Started but never confirmed; not a factor, and replaced by the next enrol. */
  pending: boolean;
  activatedAt: string | null;
  lastUsedAt: string | null;
  /** Unspent recovery codes. Zero on an enabled enrolment is worth warning about. */
  recoveryCodesRemaining: number;
  recoveryCodesTotal: number;
  recoveryGeneratedAt: string | null;
  /** Set while the account is locked out after repeated wrong codes. */
  lockedUntil: string | null;
}

/** What POST /auth/totp/enrol returns — shown once, never stored. */
export interface TotpEnrolment {
  /** Base32 secret, for typing into an app that can't scan. */
  secret: string;
  /** `otpauth://totp/…` — the QR payload. */
  otpauthUri: string;
}

/** A password sign-in that still owes a second factor (POST /auth/login). */
export interface MfaChallenge {
  mfaRequired: true;
  challengeId: string;
  /** Unix seconds. */
  expiresAt: number;
  methods: Array<'totp' | 'recovery'>;
}

/** One registered passkey, as GET /auth/webauthn/credentials reports it. */
export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  /** Never used yet → null. */
  lastUsedAt: string | null;
  /** Synced/backed-up (a keychain passkey) rather than bound to one device. */
  backedUp: boolean;
  transports: string[];
}

/** A user's membership in an organization. */
/** The current user's preferences for the active organization (`/user/preferences`). */
export interface UserPreferences {
  favorites: string[];
  recents: string[];
  notifications: {
    /** Hide the quota banner while usage is only nearing a limit. */
    muteQuotaWarnings: boolean;
  };
}

export interface UserOrgMembership {
  id: string;
  name: string;
  slug?: string;
  role: 'owner' | 'admin' | 'member';
  /** Parent org id when this org is a team (org → team hierarchy); absent for top-level orgs. */
  parentOrgId?: string;
  /** Org's quota tier — used to gate tier-gated actions (only team/enterprise roots may parent teams). */
  tier?: 'developer' | 'pro' | 'team' | 'enterprise';
}

// The runtime user guards now live in `@/lib/auth-helpers` (a `.ts` file can't
// hold both the type contracts and their runtime helpers cleanly). Re-exported
// here for back-compat so existing `from '@/types'` importers keep working.
export { isSystemAdmin, isOrgAdmin, hasPermission } from '@/lib/auth-helpers';

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

/** Coarse role a permission Role grants its members (mirrors backend ROLE_GRANTS). */
export type RoleGrant = 'superadmin' | 'admin' | 'member';

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
 * Quota + tier identifiers — re-exported from api-core so the frontend union
 * can't drift from the backend's. The local copy previously listed only 4 of
 * the 9 quota types, silently under-typing quota responses.
 */
export type { QuotaType, QuotaTier, Visibility, Criticality, EntityLink, Lifecycle, OwnerType, TemplateInput };

/**
 * The quota kinds the dashboard currently surfaces — a curated subset of the
 * backend's full `QuotaType` (which also tracks `storageBytes`, `dashboards`,
 * `alertRules`, `alertDestinations`, `idpConfigs`). Key display/config maps by
 * {@link DisplayedQuotaType} so they needn't enumerate quota kinds the UI does
 * not render. The `satisfies` clause fails the build if any entry stops being a
 * valid `QuotaType`, so this list can't silently drift either.
 */
export const DISPLAYED_QUOTA_TYPES = [
  'plugins', 'pipelines', 'apiCalls', 'aiCalls',
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
  isDefault?: boolean;
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
  /** Quota tier ('developer' | 'pro' | 'team' | 'enterprise'). Optional because some
   *  list endpoints elide it to keep payloads small. */
  tier?: string;
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
}

/**
 * Per-org IdP config DTO. Mirrors the platform service's OrgIdpConfigDto —
 * the client secret never crosses the wire; UI shows `hasClientSecret`.
 */
export type IdpProvider = 'generic-oidc' | 'cognito' | 'google' | 'github';

/** Which federation protocol the org's IdP speaks. One config per org, so this
 *  is a selector, not a list: an org signs in over OIDC or over SAML. */
export type IdpProtocol = 'oidc' | 'saml';

/** Per-org attribute names carrying identity fields in a SAML assertion. Empty
 *  means "use the common spellings" (`email`, `displayName`, `groups`, plus the
 *  Entra/Shibboleth URI forms). */
export interface SamlAttributeMapping {
  email?: string;
  name?: string;
  groups?: string;
}

/** The service-provider values an IdP administrator needs to create the
 *  application on their side. Derived server-side from the org id and the
 *  deployment URL — never stored, and available before the connection works. */
export interface SamlSpDetails {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
}

export interface OrgIdpConfigDto {
  orgId: string;
  protocol: IdpProtocol;
  /** OIDC only — absent on a SAML config. */
  provider?: IdpProvider;
  clientId?: string;
  hasClientSecret: boolean;
  /** SAML: the IdP's entity ID (its `Issuer`). */
  samlEntityId?: string;
  /** SAML: the IdP's SSO endpoint (HTTP-Redirect binding). */
  samlSsoUrl?: string;
  /** SAML: trusted IdP signing certificates — more than one while a rotation's
   *  overlap window is open. Public certificates, so they are returned in full. */
  samlCertificates: string[];
  samlAttributes?: SamlAttributeMapping;
  samlSp?: SamlSpDetails;
  discoveryUrl?: string;
  /** Cognito only: the discovery URL is derived server-side from these. */
  region?: string;
  userPoolId?: string;
  /** id_token claim carrying group memberships, for just-in-time Role mapping.
   *  Absent = the `groups` default. Never set for Google (no group claims). */
  groupsClaim?: string;
  allowedEmailDomains: string[];
  enabled: boolean;
  updatedAt: string;
}

/**
 * One IdP group → Role mapping rule. At SSO sign-in the groups on the user's
 * id_token are matched against these (case-insensitively) and the union of their
 * Roles is granted in that org. `roles` is the hydrated form of `roleIds` so the
 * editor can name what a group grants without a second request.
 */
export interface IdpGroupMappingDto {
  id: string;
  group: string;
  roleIds: string[];
  roles: Array<{ id: string; name: string; grantsRole: 'superadmin' | 'admin' | 'member' }>;
  updatedAt: string;
}

/** Create-IdP payload. `clientSecret` is required on create. */
export interface OrgIdpConfigCreate {
  orgId?: string;
  /** Omitted leaves the stored protocol alone — the OIDC and SAML editors are
   *  separate surfaces on one page, and neither may wipe the other's
   *  connection just by saving. */
  protocol?: IdpProtocol;
  provider?: IdpProvider;
  clientId?: string;
  clientSecret?: string;
  /** SAML: required together when `protocol` is `saml`. */
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlCertificates?: string[];
  samlAttributes?: SamlAttributeMapping;
  discoveryUrl?: string;
  /** Cognito only: server derives the discovery URL from region + userPoolId. */
  region?: string;
  userPoolId?: string;
  /** Rejected by the server for Google/GitHub — they issue no group claims. */
  groupsClaim?: string;
  allowedEmailDomains?: string[];
  enabled?: boolean;
}

/**
 * BullMQ build queue job counts (admin-only)
 */
export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface QueueStatus extends QueueCounts {
  dlq?: QueueCounts;
  /** Per-tier breakdown of waiting/active/etc. counts. Aggregate fields on
   *  the root object are the sum across all tier queues. */
  tiers?: Record<string, QueueCounts>;
}

/**
 * Plugin model
 */
export interface Plugin {
  // Primary key
  id: string;
  
  // Organization and access control
  orgId: string;
  
  // Audit fields
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  
  // Core plugin information
  name: string;
  description?: string;
  keywords: string[];
  category?: string;
  version: string;
  
  // Plugin configuration
  metadata: Record<string, string | number | boolean>;
  pluginType: string;
  computeType: string;
  timeout?: number;
  failureBehavior?: 'fail' | 'warn' | 'ignore';
  secrets?: Array<{ name: string; required: boolean; description?: string }>;

  // Build configuration
  env: Record<string, string>;
  /** Docker build args, templatable via `{{ pipeline.* }}` (e.g. `{{ pipeline.vars.* }}`). */
  buildArgs?: Record<string, string>;
  installCommands: string[];
  commands: string[];
  
  // Output configuration
  primaryOutputDirectory?: string;

  // Docker configuration
  /** Computed image URI: `<namespace>/<name>:<version>`. Server-side derived. */
  uri: string;
  dockerfile?: string;

  // Developer-portal catalog metadata (ownership / lifecycle / classification)
  ownerId?: string | null;
  ownerType?: OwnerType | null;
  lifecycle?: Lifecycle;
  criticality?: Criticality | null;
  labels?: Record<string, string>;
  links?: EntityLink[];

  // Access and visibility
  visibility: Visibility;
  isDefault: boolean;
  isActive: boolean;

  // Deletion tracking (soft delete)
  deletedAt?: string;
  deletedBy?: string;
}

/**
 * Builder props for pipeline configuration.
 * Mirrors the canonical BuilderProps from @pipeline-builder/pipeline-core
 * but without CDK-specific type imports.
 */
export interface BuilderProps {
  project: string;
  organization: string;
  pipelineName?: string;
  global?: Record<string, string | number | boolean>;
  /** Pipeline-level template variables, exposed to `{{ pipeline.vars.* }}`. */
  vars?: Record<string, string | number | boolean>;
  defaults?: Record<string, unknown>;
  role?: Record<string, unknown>;
  synth: Record<string, unknown>;
  stages?: Record<string, unknown>[];
}

/**
 * Typed views for AI-generated BuilderProps structure.
 * Used by GitUrlTab to safely access nested plugin references
 * within the loosely-typed BuilderProps.synth / BuilderProps.stages.
 */

/** Plugin reference as it appears in AI-generated BuilderProps JSON. */
export interface GeneratedPluginRef {
  name: string;
  alias?: string;
  filter?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Typed view of an AI-generated stage step. */
export interface GeneratedStageStep {
  plugin: GeneratedPluginRef;
  [key: string]: unknown;
}

/** Typed view of an AI-generated stage. */
export interface GeneratedStage {
  stageName: string;
  alias?: string;
  steps: GeneratedStageStep[];
}

/** Typed view of the AI-generated synth section. */
export interface GeneratedSynth {
  plugin: GeneratedPluginRef;
  [key: string]: unknown;
}

/**
 * Narrow a loosely-typed `BuilderProps.synth` / `.stages` (arbitrary plugin-
 * config JSON, `Record<string, unknown>`) to the AI-generated view. The wire
 * shape is genuinely untyped, so this is an unavoidable assertion — centralized
 * and documented here instead of scattering `as unknown as GeneratedSynth` at
 * each read in the AI-generation UI (which only renders AFTER generation
 * produces this shape). Prefer these over inline casts.
 */
export function asGeneratedSynth(synth: Record<string, unknown>): GeneratedSynth {
  return synth as unknown as GeneratedSynth;
}

export function asGeneratedStages(stages: Record<string, unknown>[] | undefined): GeneratedStage[] {
  return (stages ?? []) as unknown as GeneratedStage[];
}

/**
 * Create pipeline request data
 * Only props (based on BuilderProps) and visibility are required
 */
export interface CreatePipelineData {
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords?: string[];
  props: BuilderProps;
  visibility?: Visibility;
}

/**
 * Pipeline model
 */
export interface Pipeline {
  // Primary key
  id: string;
  
  // Organization and access control
  orgId: string;
  
  // Audit fields
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  
  // Core pipeline information
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords: string[];
  
  // Pipeline configuration
  props: BuilderProps;

  // Developer-portal catalog metadata (ownership / lifecycle / classification)
  ownerId?: string | null;
  ownerType?: OwnerType | null;
  lifecycle?: Lifecycle;
  criticality?: Criticality | null;
  labels?: Record<string, string>;
  links?: EntityLink[];

  // Access and visibility
  visibility: Visibility;
  isDefault: boolean;
  isActive: boolean;

  // Deletion tracking (soft delete)
  deletedAt?: string;
  deletedBy?: string;
}

/** DORA performance band (shared with the reporting domain type). */
export type ScorecardDoraLevel = 'elite' | 'high' | 'medium' | 'low' | null;

/**
 * Per-pipeline maturity scorecard: compliance posture + DORA bands → a graded
 * 0–100 score. Mirrors the server `Scorecard` shape.
 */
export interface PipelineScorecard {
  pipelineId: string;
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | 'N/A';
  compliance: {
    score: number | null;
    rulesEvaluated: number;
    violations: number;
    warnings: number;
  };
  dora: {
    score: number | null;
    basis: 'deploy' | 'run';
    deploymentFrequency: ScorecardDoraLevel;
    changeFailureRate: ScorecardDoraLevel;
    meanTimeToRestore: ScorecardDoraLevel;
    leadTime: ScorecardDoraLevel;
  };
  computedAt: string;
}

/** One pipeline's scorecard within the org-wide roll-up (adds its display name). */
export interface ScorecardLeaderboardEntry extends PipelineScorecard {
  name?: string;
}

/**
 * Org-wide "software health" roll-up: every pipeline graded, ranked, plus
 * aggregate stats. Mirrors the server `rollup` shape from GET /pipelines/scorecard.
 */
export interface ScorecardRollup {
  orgId: string;
  pipelineCount: number;
  scored: number;
  averageScore: number | null;
  gradeDistribution: Record<string, number>;
  leaderboard: ScorecardLeaderboardEntry[];
  computedAt: string;
  truncated: boolean;
  /** Pipelines whose score could not be COMPUTED (an error), as opposed to
   *  computed with no data. The roll-up degrades per row rather than failing
   *  the page, so this is how a partial result announces itself. */
  failed?: number;
}

/**
 * Golden-path pipeline template (parameterized starter).
 */
/**
 * Template visibility ladder. Unlike the pipeline/plugin catalogs' two-value
 * `visibility`, templates have a personal rung so an author can iterate on a
 * draft before sharing it:
 * - `private` — only the author (`createdBy`) sees or edits it
 * - `org`     — everyone in the owning org sees it
 * - `public`  — shared with the org and its teams (needs `pipelines:publish`);
 *               the system org's public templates are the catalog every org sees
 */
export type TemplateVisibility = 'private' | 'org' | 'public';

export interface PipelineTemplate {
  id: string;
  orgId: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  name: string;
  description?: string | null;
  keywords: string[];
  category: string;
  /** Template body: a BuilderProps with `{{ vars.* }}` placeholders. */
  props: BuilderProps;
  /** Declared inputs the user fills in to instantiate. */
  inputs: TemplateInput[];
  ownerId?: string | null;
  ownerType?: OwnerType | null;
  lifecycle?: Lifecycle;
  criticality?: Criticality | null;
  labels?: Record<string, string>;
  links?: EntityLink[];
  /** Three-rung ladder — see {@link TemplateVisibility}. */
  visibility: TemplateVisibility;
  isActive: boolean;
  /** Soft-delete tombstone fields (set when deleted; powers "recently deleted"). */
  deletedAt?: string | null;
  deletedBy?: string | null;
}

/**
 * Invitation model
 */
export interface Invitation {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedBy: string;
  inviterName: string;
  organizationId: string;
  organizationName: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Billing interval for subscriptions
 */
export type BillingInterval = 'monthly' | 'annual';

/**
 * Subscription lifecycle status
 */
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'unpaid' | 'trialing' | 'incomplete';

/**
 * Plan definition from the billing API
 */
export interface Plan {
  id: string;
  name: string;
  description: string;
  tier: QuotaTier;
  prices: {
    monthly: number;
    annual: number;
  };
  features: string[];
  isDefault: boolean;
  sortOrder: number;
}

/**
 * Subscription info from the billing API
 */
export interface Subscription {
  id: string;
  orgId: string;
  planId: string;
  planName?: string;
  tier?: QuotaTier;
  status: SubscriptionStatus;
  interval: BillingInterval;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /** Purchased add-on bundles (docs/billing-bundles.md). */
  addons?: Array<{ bundleId: string; quantity: number }>;
  /** A standing recurring operator discount attached to this subscription (a
   *  per-period usage credit). `null`/absent when none. One-time/credit discounts
   *  aren't stored here — they apply once and show up in Billing History. */
  recurringDiscount?: { discountId: string; value?: number; unit?: 'dollar' | 'percent'; kind?: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** An operator-granted discount record (docs/billing-discounts.md). Price-only —
 *  never changes quotas/tier. `value` is percent-points when `unit==='percent'`,
 *  else whole cents. Tokens are issued separately and never returned here. */
export interface Discount {
  id: string;
  value: number;
  unit: 'dollar' | 'percent';
  kind: 'onetime' | 'recurring' | 'credit';
  campaign?: string;
  alias?: string;
  targetOrgId?: string;
  maxRedemptions?: number;
  timesRedeemed: number;
  redeemBy?: string;
  appliesToTiers?: string[];
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** A purchasable add-on bundle (expansion revenue). */
export interface Bundle {
  id: string;
  name: string;
  description: string;
  grants: Record<string, number>;
  features?: string[];
  prices: { monthly: number; annual: number };
  stackable: boolean;
  /** Optional per-unit volume discount tiers (e.g. the per-seat `seat` bundle):
   *  at ≥ minQuantity units, discountPercent comes off the line. Highest wins. */
  volumeTiers?: { minQuantity: number; discountPercent: number }[];
  maxQuantity?: number;
  availableForTiers: QuotaTier[];
  /** Prerequisite bundle ids that must be held first (e.g. Advanced → Standard Compliance). */
  requires?: string[];
  /** Prerequisite feature flags the plan or a held add-on must provide. */
  requiresFeatures?: string[];
  /** Set by `GET /billing/bundles` when the account doesn't meet a prerequisite
   *  yet — the same gate the add route 400s on, so the card can explain it. */
  unmetRequirement?: { bundleIds: string[]; features: string[]; message: string };
}

/** A combo discount advertised in the bundle catalog: owning every member bundle
 *  bills the set at a reduced combined price (realized as a recurring usage
 *  credit). `savings` is the per-interval reduction vs buying the members apart. */
export interface ComboDiscount {
  id: string;
  name: string;
  bundleIds: string[];
  /** Per-member minimum quantity (bundleId → count; absent ⇒ 1). */
  minQuantities?: Record<string, number>;
  savings: { monthly: number; annual: number };
}

/** A combo discount gained or lost by a proposed add-on change. */
export interface ComboChange {
  comboId: string;
  name: string;
  creditCents: number;
}

/** An itemized price line + total returned by the add-on preview/mutation. */
export interface AddonPriceBreakdown {
  interval: string;
  items: Array<{ label: string; quantity: number; cents: number }>;
  totalCents: number;
}

/** Result of an add-on add/remove/preview: effective limits + itemized price. */
export interface AddonResult {
  addons: Array<{ bundleId: string; quantity: number }>;
  effectiveLimits: Record<string, number>;
  priceBreakdown: AddonPriceBreakdown;
  subscription?: Subscription;
  /** Combo discounts this change would end / unlock (drives the removal warning). */
  lostCombos?: ComboChange[];
  gainedCombos?: ComboChange[];
}

/**
 * Billing event from the admin API
 */
export interface BillingEvent {
  id: string;
  orgId: string;
  subscriptionId?: string;
  type: string;
  details: Record<string, unknown>;
  createdAt: string;
}

/**
 * Per-quota row in the cost+usage rollup. `remaining` and
 * `percentOfLimit` are null when the quota is unlimited (limit === -1) so
 * the UI knows to render an em-dash instead of a misleading progress bar.
 */
export interface UsageEntry {
  used: number;
  limit: number;
  remaining: number | null;
  percentOfLimit: number | null;
  resetAt: string;
}

/**
 * Pooled seat usage for the account (root). `limit === -1` means unlimited.
 * Sourced from platform (seats aren't a quota type), so it's `null` on the
 * rollup when that read fails — the rest of the usage view still renders.
 */
export interface SeatUsage {
  used: number;
  limit: number;
}

/** Response shape of `GET /api/billing/usage` (cost attribution surface). */
export interface UsageRollup {
  period: {
    start: string;
    end: string;
    daysElapsed: number;
    daysRemaining: number;
  };
  subscription: {
    planId: string;
    planName: string;
    tier: 'developer' | 'pro' | 'team' | 'enterprise';
    interval: 'monthly' | 'annual';
    priceCents: number;
  } | null;
  usage: Record<string, UsageEntry>;
  /** Pooled seat usage for the account. `null` when the platform read failed. */
  seats: SeatUsage | null;
  cost: {
    subscriptionCents: number;
    currency: 'USD';
  };
}

/**
 * Message type identifiers
 */
export type MessageType = 'announcement' | 'conversation';

/**
 * Message priority levels
 */
export type MessagePriority = 'normal' | 'high' | 'urgent';

/**
 * Internal message model
 */
/** Attachment metadata (the blob is fetched separately, auth-gated). */
export interface MessageAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface Message {
  id: string;
  orgId: string;
  /**
   * Display name of the sender org (`orgId`), resolved server-side. Optional —
   * absent when the name couldn't be resolved, so the UI falls back to the id.
   */
  orgName?: string;
  threadId: string | null;
  recipientOrgId: string;
  /** Display name of the recipient org (`recipientOrgId`); see `orgName`. Unset for '*' broadcasts. */
  recipientOrgName?: string;
  /**
   * Optional per-user target WITHIN `recipientOrgId`. Null (default) = the whole
   * recipient org sees it; when set, only this user does. Announcement broadcasts
   * ('*' recipient) never set this.
   */
  recipientUserId: string | null;
  messageType: MessageType;
  /**
   * Logical channel/inbox bucket (e.g. 'support', 'help'). Null for
   * org-to-org conversations that don't belong to a channel.
   */
  channel: string | null;
  subject: string;
  content: string;
  /**
   * Per-participant read receipts: maps `orgId` → ISO timestamp of when that
   * org marked the thread read. Empty `{}` means no participant has read it.
   * Sender's mark-as-read does not flip recipient's view and vice-versa.
   */
  readBy: Record<string, string>;
  priority: MessagePriority;
  /** Attachment metadata, embedded by the thread endpoint (absent on list rows). */
  attachments?: MessageAttachment[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Set when the author edited the content after sending (drives the "edited" hint). */
  editedAt?: string | null;
  visibility: Visibility;
  isDefault: boolean;
  isActive: boolean;
  deletedAt?: string;
  deletedBy?: string;
}

/**
 * The session tokens a browser client receives.
 *
 * There is no `refreshToken` field: for browser callers the platform returns the
 * refresh token as an HttpOnly cookie scoped to `/api/auth/refresh`, which no
 * script can read. The access token lives in memory only.
 */
export interface AuthTokens {
  accessToken: string;
  /** Access-token lifetime in seconds, when the endpoint reports it. */
  expiresIn?: number;
}

/**
 * Standard API response envelope (matches backend).
 *
 * Discriminated union on `success` so TypeScript narrows `data` to `T`
 * (not `T | undefined`) once `success === true` has been checked.
 *
 * Note: callers of `ApiClient.request()` rarely need to check `success` 
 * the client throws `ApiError` on 4xx/5xx, so success: false never
 * reaches caller code. The union is here for the few callsites that
 * inspect the raw envelope (e.g. SSE bootstrap, error inspectors).
 */
export type ApiResponse<T = unknown> =
  | {
    success: true;
    statusCode: number;
    data: T;
    message?: string;
    timestamp?: string;
  }
  | {
    success: false;
    statusCode: number;
    data?: undefined;
    message?: string;
    code?: string;
    details?: Record<string, unknown>;
    timestamp?: string;
  };

// ============================================================================
// Image Registry (sysadmin-only registry browser; replaces the joxit UI)
// ============================================================================

/** One repository entry from /v2/_catalog. */
export interface RegistryRepository { name: string }

/** Tag list for a single repo. `tags` is null when the repo exists but is empty. */
export interface RegistryTagList { name: string; tags: string[] | null }

/** Top-level OCI / Docker v2 manifest envelope. */
export interface RegistryManifest {
  mediaType: string;
  digest: string;
  size: number;
  body: unknown;
}

/** Parsed image config blob (OCI v1 image config spec). The registry now
 *  rejects manifests that omit required OCI fields, so `architecture` and
 *  `os` are guaranteed present. `config` and `history` remain optional per
 *  the spec (a scratch image can have an empty config, etc.). */
export interface RegistryImageConfig {
  created?: string;
  architecture: string;
  os: string;
  config?: { Env?: string[]; Cmd?: string[]; WorkingDir?: string };
  history?: { created: string; created_by?: string }[];
}

/** One platform manifest entry inside an OCI image index. */
export interface RegistryPlatformRef {
  digest: string;
  mediaType: string;
  platform: { os: string; architecture: string; variant?: string };
  size: number;
}

/**
 * Discriminated union of what `useImageDetail` returns * - `image`: single-arch manifest; `config` carries the parsed config blob.
 * - `index`: multi-arch index; `platforms` lists referenced child manifests
 * so the UI can drill into a specific platform.
 * - `unknown`: mediaType isn't one we recognise  JSON viewer only.
 */
export type RegistryManifestKind =
  | { kind: 'image'; manifest: RegistryManifest; config: RegistryImageConfig }
  | { kind: 'index'; manifest: RegistryManifest; platforms: RegistryPlatformRef[] }
  | { kind: 'unknown'; manifest: RegistryManifest; reason: string };

/** Result of a successful `copyImage` call. */
export interface RegistryCopyResult {
  source: string;
  target: string;
  digest: string;
  mounted: { manifests: number; blobs: number };
}

/** Grouped repos for the sidebar list (system first, then `org-*` alphabetical). */
export interface RegistryRepoGroup {
  namespace: 'system' | `org-${string}`;
  repos: RegistryRepository[];
}

/**
 * One pipeline's execution-count row from `/api/reports/execution/count`
 * (the `pipelines[]` entries). Canonical shape shared by the reports, dashboard,
 * and executions pages — mirrors the `getExecutionCount` API return type.
 */
export interface ExecutionCountRow {
  id: string;
  project: string;
  organization: string;
  pipeline_name: string | null;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  first_execution: string | null;
  last_execution: string | null;
}


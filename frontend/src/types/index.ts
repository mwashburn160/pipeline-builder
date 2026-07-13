// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Quota + tier identifiers come from the api-core source of truth (see below).
// `import type` is fully erased at build time, so this pulls no server-only
// runtime code into the Next bundle.
import type { QuotaType, QuotaTier } from '@pipeline-builder/api-core';

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
  tier?: QuotaTier;
  features?: string[];
  /**
   * Effective fine-grained permissions for the active org (RBAC): the role's
   * base bundle ∪ any custom-group grants; superadmins get all. Client-visible
   * for UI gating only — every privileged action is re-checked server-side.
   */
  permissions?: string[];
  featureOverrides?: Record<string, boolean>;
  /** All organizations this user belongs to, with per-org roles */
  organizations?: UserOrgMembership[];
  createdAt?: string;
  updatedAt?: string;
}

/** A user's membership in an organization. */
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
export type { QuotaType, QuotaTier };

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
export interface OrgIdpConfigDto {
  orgId: string;
  provider: 'generic-oidc' | 'google' | 'github';
  clientId: string;
  hasClientSecret: boolean;
  discoveryUrl?: string;
  allowedEmailDomains: string[];
  enabled: boolean;
  updatedAt: string;
}

/** Create-IdP payload. `clientSecret` is required on create. */
export interface OrgIdpConfigCreate {
  orgId?: string;
  provider: 'generic-oidc' | 'google' | 'github';
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
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
  installCommands: string[];
  commands: string[];
  
  // Output configuration
  primaryOutputDirectory?: string;

  // Docker configuration
  /** Computed image URI: `<namespace>/<name>:<version>`. Server-side derived. */
  uri: string;
  dockerfile?: string;
  
  // Access and visibility
  accessModifier: 'public' | 'private';
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
 * Create pipeline request data
 * Only props (based on BuilderProps) and accessModifier are required
 */
export interface CreatePipelineData {
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords?: string[];
  props: BuilderProps;
  accessModifier?: 'public' | 'private';
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
  
  // Access and visibility
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  
  // Deletion tracking (soft delete)
  deletedAt?: string;
  deletedBy?: string;
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
 * Log entry from Loki
 */
export interface LogEntry {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
  parsed: Record<string, unknown>;
}

/**
 * Log query result from platform API
 */
export interface LogQueryResult {
  entries: LogEntry[];
  stats: { entriesReturned: number; query: string };
}

/**
 * Billing interval for subscriptions
 */
export type BillingInterval = 'monthly' | 'annual';

/**
 * Subscription lifecycle status
 */
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';

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
  createdAt: string;
  updatedAt: string;
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
  availableForTiers: QuotaTier[];
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
export interface Message {
  id: string;
  orgId: string;
  threadId: string | null;
  recipientOrgId: string;
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
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  accessModifier: 'public' | 'private';
  isDefault: boolean;
  isActive: boolean;
  deletedAt?: string;
  deletedBy?: string;
}

/**
 * Auth tokens
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
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


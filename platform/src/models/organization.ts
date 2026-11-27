// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, PLAN_TIERS, type PlanTier, type PlanTierLimits, VALID_TIERS, nextQuotaResetDate, quotaPeriodDays } from '@pipeline-builder/api-core';
import { Schema, model, Types, Model, type HydratedDocument } from 'mongoose';
import { IMPERSONATION_POLICIES } from '../constants/vocabulary.js';
import { nextOrgSlug, orgSlugBase, orgSlugCollisionPattern } from '../helpers/org-slug.js';

/**
 * Quota usage tracking interface
 */
export interface QuotaUsage {
  used: number;
  resetAt: Date;
}

/**
 * Quota limits interface.
 *
 * Aliased to api-core's `PlanTierLimits` so the schema, the in-memory
 * preset tables, and every consumer stay in lockstep — adding a new
 * countable resource in `PLAN_TIERS` surfaces a compile error in the
 * schema-defaults block below.
 */
export type QuotaLimits = PlanTierLimits;

/**
 * Quota usage interface
 */
export interface QuotaUsageTracking {
  plugins: QuotaUsage;
  pipelines: QuotaUsage;
  apiCalls: QuotaUsage;
  automationCalls: QuotaUsage;
  aiCalls: QuotaUsage;
}

export type { PlanTier };

/**
 * Organization document interface.
 *
 * Membership is not embedded here: it is managed through the {@link UserOrganization} junction collection, which stores
 * per-org roles ('owner' | 'admin' | 'member') and an `isActive` flag.
 *
 * To list members of an organization, query `UserOrganization` by `organizationId`.
 * The `owner` field here is kept as a denormalized reference to the owning user.
 */
export interface OrganizationData {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  /** True for the single well-known system tenant (id = api-core SYSTEM_ORG_ID).
   *  Identifies the system org by flag rather than a magic string `_id`. */
  isSystem?: boolean;
  description?: string;
  tier: PlanTier;
  /** Account-level purchased feature entitlements (bundles), synced by billing
   *  to the root and propagated onto teams. */
  featureEntitlements: string[];
  /** Stored impersonation policy. ABSENT on most documents — read only via
   *  `resolveImpersonationPolicy`, which owns the default. */
  impersonationPolicy?: 'open' | 'consent' | 'denied';
  /** Stored self-approval flag. Same absent-value rule as `impersonationPolicy`. */
  allowSelfApproval?: boolean;
  /**
   * Org policy "require MFA": every member's session scoped to this org
   * must be `aal: 2` (a passkey, password + authenticator code, or SSO through
   * an IdP marked as enforcing MFA) or it is refused AT ISSUANCE — no route ever
   * re-checks it. Absent means off; read only through
   * `helpers/mfa-policy.ts#resolveEffectiveMfaPolicy`, which owns the default and
   * the ancestor walk (a parent org's requirement applies to its teams).
   */
  requireMfa?: boolean;
  /** When `requireMfa` was last turned ON. Stamped by the policy route so the
   *  grace deadline is derived rather than trusted from a client. */
  mfaRequiredSince?: Date;
  /**
   * End of the grace period that follows enabling `requireMfa`. Until it passes,
   * members are TOLD (the claim and the banner) but not refused, so an org can
   * turn the policy on without locking out everyone who hasn't enrolled yet.
   * Absent with `requireMfa` on means the requirement bites immediately.
   */
  mfaGraceUntil?: Date;
  /**
   * The org states that its OWN IdP enforces MFA, so an SSO sign-in through it
   * is `aal: 2`.
   *
   * A per-provider setting rather than a derived one because providers do not
   * send `amr` reliably — most OIDC IdPs send none at all, and a SAML assertion's
   * `AuthnContextClassRef` is whatever the IdP was configured to say. The org
   * administers its own IdP, so its statement is the best available evidence; it
   * lives here (beside the requirement it feeds) rather than on the IdP config,
   * and applies to whichever protocol that config speaks.
   */
  idpEnforcesMfa?: boolean;
  /**
   * Org policy "administrative actions require MFA": role, member, invitation,
   * IdP group-mapping, billing, log-export and access-key actions need an
   * `aal: 2` session even when `requireMfa` is off. Absent means off; read only
   * through `resolveEffectiveMfaPolicy` (a parent org's setting applies to its
   * teams, strictest wins). Carried to every service as the `org_admin_aal`
   * token claim and enforced by api-core's `requireOrgAdminAssurance`.
   */
  adminActionsRequireMfa?: boolean;
  /**
   * Org password policy: the minimum password length for this org's members,
   * at or above the platform minimum (`PASSWORD_MIN_LENGTH`) and at most 128.
   * Absent means the platform minimum. Enforced whenever a member SETS a
   * password (change, admin reset, registration through an invitation) and
   * checked at password SIGN-IN, where a shorter existing password must be
   * changed before a session opens. Read only through
   * `helpers/password-policy.ts`, which owns the ancestor walk (strictest wins).
   */
  passwordMinLength?: number;
  /**
   * Org authenticator policy: the passkey models (AAGUIDs, lowercase canonical
   * form) members may register. Absent/empty means any. When set, a passkey
   * registration from a member active in this org requests DIRECT attestation,
   * verified against the FIDO Metadata Service, and a model not on the list is
   * refused; a passkey sign-in with a model not on the list counts as `aal: 1`
   * in this org. Read only through `helpers/authenticator-policy.ts` (ancestor
   * lists intersect — strictest wins).
   */
  allowedAuthenticatorAaguids?: string[];
  /**
   * Org session-lifetime policy for interactive sessions: a maximum age from
   * sign-in (days) and an idle timeout since the last real activity (minutes,
   * at least 5). Either may only TIGHTEN the platform ceiling
   * (`SESSION_MAX_AGE_DAYS` / `SESSION_IDLE_TIMEOUT_MINUTES`).
   * Absent field = the platform value. Read only through
   * `helpers/session-policy.ts`, which owns the ancestor walk (strictest wins).
   */
  sessionPolicy?: { maxAgeDays?: number; idleTimeoutMinutes?: number };
  /**
   * When an org admin dismissed the one-time "finish setting up your org" guide
   * (install the CLI, store tokens, set up events) the dashboard offers org
   * admins. A UI preference, not a control: absent means the guide is still
   * offered. Written only by `PATCH /organization/:id/setup-guide`
   * (controllers/org-setup-guide.ts); clearing it re-arms the guide.
   */
  setupGuideDismissedAt?: Date;
  /** The user who dismissed the setup guide. Set and cleared together with
   *  {@link setupGuideDismissedAt}. */
  setupGuideDismissedBy?: Types.ObjectId;
  /** Denormalized reference to the owning user. Canonical ownership is in UserOrganization (role: 'owner'). */
  owner: Types.ObjectId;
  /**
   * Parent organization id for the org → team hierarchy. `null`/absent = a **root** organization; a non-null
   * value makes this org a "team" nested under its parent. Stored as a string
   * id (org `_id`s may be ObjectId or string, e.g. the well-known `'system'`
   * org), so the descendant-expansion helper matches on string ids.
   * No org sets this today — the column is the additive foundation.
   */
  parentOrgId?: string | null;
  quotas: QuotaLimits;
  usage: QuotaUsageTracking;
  /**
   * The org's AI switch. `false` turns EVERY AI entry point off for this org — Ask,
   * the agent, pipeline/plugin generation, report summaries — enforced by each
   * service through `requireOrgAIEnabled` / `resolveOrgModelSelection`, which read it
   * via `GET /internal/ai/access/:orgId`. Admin-editable (`PUT /organization/ai-config`,
   * step-up, audited). Absent = enabled.
   */
  aiEnabled?: boolean;
  /**
   * The org's own provider API keys, encrypted at rest. Key-based providers only
   * (api-core `AI_KEY_PROVIDER_IDS`) — Amazon Bedrock authenticates with the
   * deployment's IAM role, so there is no org key to store.
   */
  aiProviderKeys?: {
    anthropic?: string;
    openai?: string;
    google?: string;
    xai?: string;
  };
  /**
   * Per-org AWS IAM role for build / runtime AWS API calls. When set,
   * services that need AWS credentials for this org call `sts:AssumeRole`
   * on this ARN instead of using the service's shared role — limits the
   * blast radius of an org compromise to one customer's AWS account.
   *
   * The role's trust policy MUST require this `externalId` so a leaked
   * RoleArn alone can't be assumed by a third party (AWS "confused deputy"
   * mitigation). Operators configure this via the admin org endpoint;
   * orgs without an entry continue to use the service's shared role.
   */
  awsConfig?: {
    assumeRoleArn?: string;
    externalId?: string;
    region?: string;
    sessionDurationSeconds?: number;
  };
  /**
   * Per-org KMS configuration. When set, this org's secrets (AI provider
   * keys, IdP client secrets, …) are wrapped under THIS org's KMS CMK
   * instead of the shared master key — a CMK compromise has blast radius
   * of one org, not the whole fleet.
   *
   * Operator setup (per org):
   *   1. Create a KMS CMK with key policy allowing platform's IAM role
   *      `kms:Decrypt`.
   *   2. Generate a 32-byte master:     `head -c 32 /dev/urandom | base64`
   *   3. Wrap with KMS:                 `aws kms encrypt --key-id <KEY> --plaintext <b64>`
   *   4. Store `{ keyId, ciphertextBase64 }` in this field via the admin API.
   * Orgs without an entry fall through to the shared master (mixed-mode
   * deployments are explicitly supported).
   */
  kmsConfig?: {
    keyId?: string;
    ciphertextBase64?: string;
  };
  /**
   * Durable "verify this org's secrets under its current KMS config" marker,
   * written in the same update as every `kmsConfig` change (set or clear) and
   * due one per-org KMS cache TTL plus a margin later: by then every replica
   * has dropped the outgoing key, so a secret that still does not decrypt was
   * written under the OLD key by a replica the eviction broadcast missed. The
   * verification sweep (services/kms-config-verify.ts) claims it, checks, and
   * clears it. A later change overwrites it, superseding the pending check.
   */
  kmsVerifyDueAt?: Date;
  /**
   * The config the org's runner signing keys (pipeline Postgres) were wrapped
   * under before a KMS config change — the only durable copy of it once the
   * config is saved. Written by the change's save itself and cleared when its
   * re-wrap succeeds, so it outlives a failed re-wrap or a crash mid-request.
   * Both fields absent = the shared provider. `POST .../kms-config/runner-keys/reencrypt`
   * retries the re-wrap with it and clears it on success. While it is set, a
   * further PUT/DELETE of the config is refused (409): one marker can name only
   * one outgoing config.
   */
  kmsRunnerRewrapFrom?: { keyId?: string; ciphertextBase64?: string; pendingSince: Date };
  /**
   * Durable "paid-signup billing bootstrap still pending" marker. Set when a
   * new org selected a paid `planId` at signup but the fire-and-forget billing
   * subscription call couldn't be provisioned (billing down/unreachable, all
   * retries exhausted). The reconcile pass ({@link reconcilePendingBillingSubscriptions})
   * retries every org carrying this marker and clears it once billing actually
   * provisions the subscription — closing the fail-open gap where an org would
   * otherwise stay silently developer-tier with no bill.
   *
   * NOT a local tier grant: the org's `tier` is untouched until billing
   * provisions it (no free-paid-tier). The marker only guarantees the
   * provisioning eventually happens (or is visible to an operator).
   */
  pendingBillingPlanId?: string;
  /** When {@link pendingBillingPlanId} was first set (marker age, for operators). */
  pendingBillingSince?: Date;
  /**
   * SOFT-DELETE tombstone. Set (with {@link purgeAfter}) when a sysadmin runs
   * `DELETE /organization/:id`: instead of the immediate destructive cascade the
   * org enters a retention window. `null`/absent = a live org. Access is cut off
   * at the token chokepoint (`resolveMembership` refuses to scope a token to a
   * soft-deleted org) + a tokenVersion bump on every member, NOT via per-read
   * `deletedAt` filters. Sparse-indexed so the purge sweep's scan is cheap
   * (only tombstoned docs carry it).
   */
  deletedAt?: Date | null;
  /**
   * Set (true) when the soft-delete was made by a platform operator — a
   * takedown, which only the platform may restore. Absent on a tenant's own
   * team delete, which stays self-serve restorable. Cleared on restore.
   */
  deletedByPlatform?: boolean;
  /**
   * When the purge sweep may run the destructive cascade for this soft-deleted
   * org (= `deletedAt` + `orgPurgeRetentionMs()`, i.e. the greater of
   * `organization.deletionRetentionDays` and the shared row-level
   * `SOFT_DELETE_RETENTION_DAYS` — the org must outlive the rows it owns).
   * Until then a
   * sysadmin/owner can restore. Sparse-indexed for the sweep's
   * `{ purgeAfter: { $lte: now } }` scan.
   */
  purgeAfter?: Date | null;
  /**
   * When a purge sweep CLAIMED this org, so two runners cannot cascade-delete it
   * at the same time.
   *
   * The sweep is a scan-then-act loop, and its idempotency only ever covered
   * SEQUENTIAL retry — an org left mid-purge is picked up next tick. Nothing
   * stopped two concurrent runners from both matching the same org and both
   * running `cascadeDeleteOrg`, which the cross-pod leader lock normally prevents
   * but which the lock's own no-Redis fallback used to allow across every replica.
   * The claim makes the guarantee the sweep's own, independent of Redis.
   *
   * A claim older than {@link PURGE_CLAIM_STALE_MS} is reclaimable: the claimant
   * died mid-cascade, and the cascade is safe to resume (that is the sequential
   * idempotency the sweep always had).
   */
  purgeStartedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How long a purge claim is honoured before another sweep may take it over. Long
 * enough that a slow-but-live cascade is never stolen, short enough that a pod
 * dying mid-cascade does not park the org for a whole retention window.
 */
export const PURGE_CLAIM_STALE_MS = 30 * 60 * 1000;

export type OrganizationDocument = HydratedDocument<OrganizationData>;

const quotaUsageSchema = new Schema<QuotaUsage>(
  {
    used: { type: Number, default: 0, min: 0 },
    resetAt: { type: Date, default: () => nextQuotaResetDate() },
  },
  { _id: false },
);

/**
 * Compile-time key-coverage guard for the persisted `quotas` sub-document.
 *
 * The Mongoose `quotas` block below persists every FLOW quota dimension but
 * DELIBERATELY EXCLUDES the two BILLING-OWNED retention dims
 * (`eventRetentionDays` / `doraRetentionDays`): those live only on the
 * reporting store's `dora_settings` (written by the billing→reporting
 * retention-sync leg), never on the org doc — and platform's quota reseeds
 * skip them (see `RESEED_EXCLUDED_DIMS` in organization-quota.ts).
 *
 * `PERSISTED_QUOTA_KEYS` must list EXACTLY the keys the schema block persists.
 * The `satisfies` clause rejects any typo, stale, or retention key; the
 * `_AllPersistedKeysCovered` assertion rejects a MISSING one. Together they
 * make adding a new non-retention dimension to `PlanTierLimits` (in api-core)
 * a real COMPILE ERROR here until it is added both to the schema block and to
 * this list.
 */
type PersistedQuotaKey = Exclude<keyof PlanTierLimits, 'eventRetentionDays' | 'doraRetentionDays'>;
const PERSISTED_QUOTA_KEYS = [
  'plugins', 'pipelines', 'apiCalls', 'automationCalls', 'aiCalls', 'storageBytes',
  'cpuCredits',
  'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs', 'listings', 'seats',
  'supportContacts', 'supportPremiumContacts',
] as const satisfies readonly PersistedQuotaKey[];
type _AllPersistedKeysCovered =
  Exclude<PersistedQuotaKey, (typeof PERSISTED_QUOTA_KEYS)[number]> extends never
    ? true
    : ['MISSING quota key in organizationSchema.quotas', Exclude<PersistedQuotaKey, (typeof PERSISTED_QUOTA_KEYS)[number]>];
const _persistedQuotaKeysExhaustive: _AllPersistedKeysCovered = true;
void _persistedQuotaKeysExhaustive;
void PERSISTED_QUOTA_KEYS;

const organizationSchema = new Schema<OrganizationData>(
  {
    _id: {
      type: Schema.Types.ObjectId,
      default: () => new Types.ObjectId(),
    },
    name: {
      type: String,
      required: [true, 'Organization name is required'],
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    isSystem: {
      type: Boolean,
      default: false,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    tier: {
      type: String,
      // Drive the Mongoose enum from api-core's `VALID_TIERS` tuple so adding
      // a tier in api-core surfaces here automatically (no string drift
      // between the type and the schema).
      enum: [...VALID_TIERS],
      // Default to the operator-configured DEFAULT_PLAN_TIER (api-core resolves
      // it from env; falls back to 'developer'). Quota defaults below track the
      // same tier so a new org's tier and seeded limits stay consistent.
      default: DEFAULT_TIER,
    },
    // Account-level feature entitlements purchased via bundles (audit_log/sso).
    // Billing syncs these to the ROOT org; unioned into `resolveUserFeatures`.
    featureEntitlements: {
      type: [String],
      default: [],
    },
    // Whether platform operators may view as this org's members, and on what
    // terms. NO Mongoose `default:` here, deliberately — an org that never chose
    // a policy stores nothing, and the default lives in exactly one place:
    // `resolveImpersonationPolicy` (helpers/impersonation-policy.ts). A schema
    // default would be a second copy of it (and `.lean()` reads and partial
    // projections would still see the field absent). Read the field only
    // through that resolver.
    impersonationPolicy: {
      type: String,
      enum: [...IMPERSONATION_POLICIES],
    },
    // Whether a challenge may be sent to the impersonated user themselves. When
    // false, every challenge goes to the org's admins. Same no-default rule as
    // above, for the same reason.
    allowSelfApproval: {
      type: Boolean,
    },
    // Org policy "require MFA". Same no-default rule as the two above: the
    // default lives in `resolveEffectiveMfaPolicy`.
    requireMfa: {
      type: Boolean,
    },
    mfaRequiredSince: {
      type: Date,
    },
    mfaGraceUntil: {
      type: Date,
    },
    idpEnforcesMfa: {
      type: Boolean,
    },
    // Org policy "administrative actions require MFA". Same no-default rule.
    adminActionsRequireMfa: {
      type: Boolean,
    },
    // Org password policy — absent means the platform minimum (no default, so
    // an untouched org stores nothing).
    passwordMinLength: {
      type: Number,
      min: 1,
      max: 128,
    },
    // Org authenticator (AAGUID) allowlist — absent/empty means any model.
    allowedAuthenticatorAaguids: {
      type: [String],
      default: undefined,
    },
    // Org session-lifetime policy — absent (or an absent field) means the
    // platform ceiling; no default, so an untouched org stores nothing.
    sessionPolicy: {
      type: new Schema(
        {
          maxAgeDays: { type: Number, min: 1, max: 365 },
          idleTimeoutMinutes: { type: Number, min: 5, max: 365 * 24 * 60 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    // Setup-guide dismissal (a UI preference) — absent means the guide is still
    // offered; no default, so an untouched org stores nothing. Set and cleared
    // as a pair by the setup-guide route.
    setupGuideDismissedAt: {
      type: Date,
      default: undefined,
    },
    setupGuideDismissedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: undefined,
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Org → team hierarchy parent (null = root). Stored as a string id and
    // indexed so descendant lookups (`{ parentOrgId: { $in: [...] } }`) are
    // cheap. See helpers/org-hierarchy.ts.
    parentOrgId: {
      type: String,
      default: null,
      index: true,
    },
    // Defaults sourced from `PLAN_TIERS[DEFAULT_TIER].limits` (the
    // DEFAULT_PLAN_TIER preset) so every persisted FLOW quota tracks the preset
    // without hand-syncing values. The two BILLING-OWNED retention dims
    // (`eventRetentionDays` / `doraRetentionDays`) are INTENTIONALLY EXCLUDED —
    // they live only on the reporting store's `dora_settings`, never on the org
    // doc (see `PERSISTED_QUOTA_KEYS` above, which enforces exactly this set at
    // compile time). Adding any OTHER new limit to `PlanTierLimits` in api-core
    // is a compile error at `PERSISTED_QUOTA_KEYS` until it is added here too.
    quotas: {
      plugins: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.plugins,
        min: -1, // -1 means unlimited
      },
      pipelines: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.pipelines,
        min: -1,
      },
      apiCalls: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.apiCalls,
        min: -1,
      },
      // Metered API calls made by org SERVICE ACCOUNTS, counted instead of
      // apiCalls (api-core `meteredQuotaTypeFor`).
      automationCalls: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.automationCalls,
        min: -1,
      },
      aiCalls: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.aiCalls,
        min: -1,
      },
      // Aggregate registry storage cap (bytes). Enforced by the
      // image-registry push-gate.
      storageBytes: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.storageBytes,
        min: -1,
      },
      // vCPU-minutes of plugin-build compute. The one counter on a MONTHLY
      // period (`quotaPeriodDays`) rather than the global three-day reset, so a
      // reseed or a reset date computed from QUOTA_RESET_DAYS is wrong for this
      // one by a factor of ten.
      cpuCredits: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.cpuCredits,
        min: -1,
      },
      // Per-org count caps on user-editable feature tables. -1 means unlimited.
      dashboards: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.dashboards,
        min: -1,
      },
      alertRules: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.alertRules,
        min: -1,
      },
      alertDestinations: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.alertDestinations,
        min: -1,
      },
      idpConfigs: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.idpConfigs,
        min: -1,
      },
      // Active plugin-ecosystem listings the org publishes (count quota;
      // docs/plugin-publishing.md "Plans and limits"). Raised by `listing_pack`.
      listings: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.listings,
        min: -1,
      },
      // Max org members. NOT usage-tracked (no counter) — enforced live at
      // invite time by counting members + pending invites. Stored as the org's
      // limit so per-org overrides via the quota CRUD API work like any limit.
      seats: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.seats,
        min: -1,
      },
      // Support contacts: the other platform-owned limit, enforced live at
      // DESIGNATION time the way seats are enforced at invite time. Base is 0 on
      // every tier (support is an add-on everywhere, included in none), so the
      // default here denies case-opening until a support bundle is purchased —
      // the paywall is this number, not a feature flag.
      supportContacts: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.supportContacts,
        min: -1,
      },
      // How many of those contacts may be UPGRADED to premium. A second
      // dimension rather than a third baseline level, because premium is an
      // upgrade bought on top of a baseline: an org holds N contacts and
      // upgrades M of them, M <= N. Base 0 everywhere, like the contacts
      // themselves.
      supportPremiumContacts: {
        type: Number,
        default: () => PLAN_TIERS[DEFAULT_TIER].limits.supportPremiumContacts,
        min: -1,
      },
    },
    usage: {
      plugins: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: nextQuotaResetDate() }),
      },
      pipelines: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: nextQuotaResetDate() }),
      },
      apiCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: nextQuotaResetDate() }),
      },
      automationCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: nextQuotaResetDate() }),
      },
      aiCalls: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: nextQuotaResetDate() }),
      },
      // The one counter on a MONTHLY period. `nextQuotaResetDate()` with no
      // argument is the global three-day window, which for credits would be
      // wrong by a factor of ten IN THE CUSTOMER'S FAVOUR — ten resets a month
      // against a cap sized for one. Every counter above may read the global
      // because every quota above shares it; this one must ask.
      cpuCredits: {
        type: quotaUsageSchema,
        default: () => ({ used: 0, resetAt: nextQuotaResetDate(quotaPeriodDays('cpuCredits')) }),
      },
    },
    aiEnabled: { type: Boolean, default: true },
    aiProviderKeys: {
      anthropic: { type: String, default: undefined },
      openai: { type: String, default: undefined },
      google: { type: String, default: undefined },
      xai: { type: String, default: undefined },
    },
    awsConfig: {
      assumeRoleArn: { type: String, default: undefined },
      externalId: { type: String, default: undefined },
      region: { type: String, default: undefined },
      // 900-43200 are the AWS-allowed bounds; effective cap is also the
      // role's MaxSessionDuration. We don't enforce the upper bound here
      // because operators occasionally need long sessions for batch jobs.
      sessionDurationSeconds: { type: Number, default: undefined, min: 900 },
    },
    kmsConfig: {
      keyId: { type: String, default: undefined },
      // The base64-wrapped 32-byte master. Safe to store at rest — it can
      // only be decrypted by an identity with kms:Decrypt on `keyId`.
      ciphertextBase64: { type: String, default: undefined },
    },
    // Post-KMS-change verification marker (see interface docs). Sparse: only
    // orgs with a change awaiting its check carry it.
    kmsVerifyDueAt: {
      type: Date,
      default: undefined,
      index: { sparse: true },
    },
    // Pending runner-signing-key re-wrap of a KMS change (see interface docs).
    kmsRunnerRewrapFrom: {
      type: new Schema({
        keyId: { type: String },
        ciphertextBase64: { type: String },
        pendingSince: { type: Date, required: true },
      }, { _id: false }),
      default: undefined,
    },
    // Durable paid-signup billing-bootstrap marker (see interface docs). Indexed
    // so the reconcile pass's `{ pendingBillingPlanId: { $exists: true, $ne: null } }`
    // scan is a cheap targeted lookup (sparse — only failed bootstraps carry it).
    pendingBillingPlanId: {
      type: String,
      default: undefined,
      index: { sparse: true },
    },
    pendingBillingSince: {
      type: Date,
      default: undefined,
    },
    // Soft-delete tombstone + purge deadline (see interface docs). Both sparse-
    // indexed so the purge sweep's `{ deletedAt: { $ne: null }, purgeAfter: { $lte } }`
    // scan touches only the (few) tombstoned docs, not every org.
    deletedAt: {
      type: Date,
      default: null,
      index: { sparse: true },
    },
    // Platform takedown marker on a soft-delete (see interface docs).
    deletedByPlatform: { type: Boolean, default: undefined },
    purgeAfter: {
      type: Date,
      default: null,
      index: { sparse: true },
    },
    // Concurrency claim for the destructive cascade (see interface docs). Not
    // indexed: it is only ever read for a doc the sweep already matched on the
    // two indexed fields above.
    purgeStartedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'organizations',
    _id: false,
  },
);

/**
 * `{ name: 1 }` — the quota service shares this collection and lists orgs sorted
 * by `{ name, _id }` (api/quota `findAll`), declaring this index in its own
 * mirror schema. Declared here too so platform's boot-time index reconcile does
 * not report it as an unknown index on every start.
 */
organizationSchema.index({ name: 1 });

/**
 * Generate unique slug from organization name
 */
organizationSchema.pre<OrganizationDocument>('validate', async function () {
  // An explicitly-set slug (self-serve identity edit) always wins — never
  // overwrite it with the name-derived auto-slug, even when the name also
  // changed in the same save.
  if (this.isModified('slug') && this.slug) return;
  if (!this.isModified('name') && this.slug) return;

  const baseSlug = orgSlugBase(this.name);
  const existingOrgs = await (this.constructor as Model<OrganizationDocument>)
    .find({
      slug: orgSlugCollisionPattern(baseSlug),
      _id: { $ne: this._id },
    })
    .select('slug')
    .lean();

  this.slug = nextOrgSlug(baseSlug, existingOrgs.map((org: { slug: string }) => org.slug));
});

export default model<OrganizationData>('Organization', organizationSchema);

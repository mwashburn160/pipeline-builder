// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, isBillingEnabled, QUOTA_TIERS, SYSTEM_ORG_ID, SYSTEM_ORG_SLUG, type QuotaTier } from '@pipeline-builder/api-core';
import { seedDefaultRoles } from './roles-service.js';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/org-id.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { User, Organization, UserOrganization, type UserDocument } from '../models/index.js';
import type { ClientSession } from 'mongoose';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { hashRefreshToken } from '../utils/token.js';

const logger = createLogger('auth-service');

/** Domain error codes thrown by service methods (mapped to HTTP status by the controller). */
export const DUPLICATE_CREDENTIALS = 'DUPLICATE_CREDENTIALS';
/** A self-serve caller tried to create/join the reserved `system` org
 *  (name === SYSTEM_ORG_SLUG) without operator authorization. The system org
 *  confers platform superadmin to its creator, so only an operator-authorized
 *  email (BOOTSTRAP_SUPERADMIN_EMAILS) may create it; everyone else is refused. */
export const RESERVED_ORG_NAME = 'RESERVED_ORG_NAME';
/** `completeOnboarding` could not resolve the caller's user or their active org. */
export const ONBOARDING_USER_NOT_FOUND = 'ONBOARDING_USER_NOT_FOUND';
export const ONBOARDING_NO_ORG = 'ONBOARDING_NO_ORG';
/** Thrown by findOrCreateOAuthUser when a social/SSO login would silently link
 *  onto a pre-existing but UNVERIFIED account. Mapped to 409 by the OAuth + OIDC
 *  callback error maps (single source, shared by both). */
export const ACCOUNT_EMAIL_UNVERIFIED = 'ACCOUNT_EMAIL_UNVERIFIED';

/**
 * Is this email operator-authorized as a platform super-admin (i.e. listed in
 * `BOOTSTRAP_SUPERADMIN_EMAILS`)? Only such emails may create/join the reserved
 * `system` org through the self-serve register / OAuth-create paths — the same
 * env-var allow-list the controlled superadmin bootstrap uses. Env is read live
 * (not cached) so an operator can change it without a code redeploy, and it's
 * unset in customer/SaaS environments (so no self-serve caller is ever
 * authorized there).
 */
function isBootstrapSuperAdminEmail(email: string | undefined): boolean {
  if (!email) return false;
  const raw = process.env.BOOTSTRAP_SUPERADMIN_EMAILS || '';
  const allow = new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
  return allow.size > 0 && allow.has(email.trim().toLowerCase());
}

/** Tier for the platform's own system org: fully `unlimited` when billing is OFF
 *  (never metered), top standard tier (`enterprise`) when ON so it reconciles
 *  like a normal high-tier org. Single source for both the org row and the
 *  register() planId echo. */
function systemOrgTier(): QuotaTier {
  return isBillingEnabled() ? 'enterprise' : 'unlimited';
}

interface RegisterInput {
  username: string;
  email: string;
  password: string;
  organizationName?: string;
  planId?: string;
}

interface RegisterResult {
  sub: string;
  email: string;
  role: 'owner';
  organizationId: string;
  organizationName: string;
  planId: string;
}

interface VerificationDispatch {
  /** Pre-hashed token to send via email link. The hash is what gets persisted; the raw token is what the user clicks. */
  rawToken: string;
  email: string;
  /** Pre-existing verified state — caller skips sending the email entirely if true. */
  alreadyVerified: boolean;
}

class AuthService {
  /**
   * Provision an owner org for a brand-new user inside an existing transaction:
   * create the Organization (applying the system-tenant fields when `isSystemOrg`),
   * the owner `UserOrganization` membership, set the user's `lastActiveOrgId`,
   * persist the user, and seed default permission Roles. Shared by `register`
   * (email) and `findOrCreateOAuthUser` (social/SSO) so the two provisioning
   * paths — including the security-sensitive system-org branch and its
   * billing-aware tier — can't drift. Caller is responsible for the reserved-
   * `system`-name authorization check before passing `isSystemOrg: true`.
   */
  private async provisionOwnerOrg(
    user: UserDocument,
    opts: { name: string; isSystemOrg: boolean; markOnboardingOrg?: boolean },
    session: ClientSession,
  ) {
    const orgData: Record<string, unknown> = {
      name: opts.isSystemOrg ? SYSTEM_ORG_SLUG : opts.name,
      owner: user._id,
    };
    if (opts.isSystemOrg) {
      // Seed the FULL tier preset so no quota falls back to a finite DEFAULT_TIER cap.
      const systemTier = systemOrgTier();
      orgData._id = SYSTEM_ORG_ID; // fixed well-known ObjectId
      orgData.slug = SYSTEM_ORG_SLUG;
      orgData.isSystem = true;
      orgData.tier = systemTier;
      orgData.quotas = { ...QUOTA_TIERS[systemTier].limits };
    }

    const [org] = await Organization.create([orgData], { session });
    await UserOrganization.create(
      [{ userId: user._id, organizationId: org._id, role: 'owner' }],
      { session },
    );
    // `lastActiveOrgId` is typed `string`; stringify the ObjectId.
    user.lastActiveOrgId = String(org._id);
    // Pin the onboarding rename target to THIS provisioned org (social signup).
    if (opts.markOnboardingOrg) user.onboardingOrgId = String(org._id);
    await user.save({ session });
    // Seed default permission Roles. The system org also gets Super Admin, and
    // its first user joins Super Admin + Admin (→ isSuperAdmin), bootstrapping
    // platform admin without the env-var list.
    await seedDefaultRoles(org._id, user._id, { isSystemOrg: opts.isSystemOrg }, session);
    return org;
  }

  /**
   * Register a new user + organization + membership in a single Mongo transaction.
   * The org name normalizes (trims, falls back to username); when it equals
   * 'system' (case-insensitive), the org is created with the system tier
   * + unlimited quotas + the literal `system` _id.
   *
   * Throws `DUPLICATE_CREDENTIALS` if email or username is already taken.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    return withMongoTransaction(async (session) => {
      const { username, email, password, organizationName, planId } = input;

      const existing = await User.exists({
        $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
      }).session(session);

      if (existing) {
        throw new Error(DUPLICATE_CREDENTIALS);
      }

      const trimmedOrgName = organizationName?.trim();
      const effectiveOrgName = trimmedOrgName && trimmedOrgName.length >= 2
        ? trimmedOrgName
        : username;

      const user = new User({ username, email, password });

      // The system tenant is identified by its well-known slug/name 'system'
      // (SYSTEM_ORG_SLUG); its `_id` is the fixed SYSTEM_ORG_ID ObjectId. Creating
      // it runs seedDefaultRoles({isSystemOrg:true}), which flags the creator
      // `isSuperAdmin` — a platform-wide grant. SECURITY: this MUST NOT be
      // reachable by an arbitrary self-serve registration (otherwise the first
      // anonymous POST /auth/register with organizationName:'system' mints a
      // platform superadmin, since mongodb-init doesn't pre-seed the system org).
      // Reserve the name: only an operator-authorized email
      // (BOOTSTRAP_SUPERADMIN_EMAILS) may create/join it; any other caller is
      // rejected outright — they may not create the system org NOR a normal org
      // literally named 'system' (which isSystemOrgId() would misclassify by name).
      const wantsSystemOrg = effectiveOrgName.toLowerCase() === SYSTEM_ORG_SLUG;
      const isSystemOrg = wantsSystemOrg && isBootstrapSuperAdminEmail(email);
      if (wantsSystemOrg && !isSystemOrg) {
        throw new Error(RESERVED_ORG_NAME);
      }

      const org = await this.provisionOwnerOrg(user, { name: effectiveOrgName, isSystemOrg }, session);

      return {
        sub: user._id.toString(),
        email: user.email,
        role: 'owner',
        organizationId: String(org._id),
        organizationName: org.name,
        // For the system org, echo its resolved (billing-aware) tier as the plan.
        planId: isSystemOrg ? systemOrgTier() : (planId || 'developer'),
      };
    });
  }

  /**
   * Persist the durable "paid-signup billing bootstrap still pending" marker on
   * an org (see Organization.pendingBillingPlanId). Called when the fire-and-forget
   * billing subscription couldn't be provisioned at signup, so the reconcile pass
   * retries it later — the paid-plan intent is never silently lost.
   *
   * `pendingBillingSince` is stamped only on the FIRST set (retries preserve the
   * original marker age) via `$setOnInsert`-style guard: we only set it when the
   * field is absent. Idempotent — re-marking an already-marked org just refreshes
   * the planId.
   */
  async setPendingBillingPlan(orgId: string, planId: string): Promise<void> {
    await Organization.updateOne(
      { _id: toOrgId(orgId) },
      [{
        $set: {
          pendingBillingPlanId: planId,
          pendingBillingSince: { $ifNull: ['$pendingBillingSince', '$$NOW'] },
        },
      }],
    );
  }

  /** Clear the pending-billing marker after billing provisions the subscription. */
  async clearPendingBillingPlan(orgId: string): Promise<void> {
    await Organization.updateOne(
      { _id: toOrgId(orgId) },
      { $unset: { pendingBillingPlanId: '', pendingBillingSince: '' } },
    );
  }

  /**
   * List orgs carrying a pending-billing marker (for the reconcile pass). Sparse
   * lookup against the `pendingBillingPlanId` index — empty on the common no-op.
   *
   * BOUNDED + ordered: returns at most `limit` orgs, OLDEST marker first
   * (`pendingBillingSince` asc), so a single pass can't walk an unbounded backlog
   * serially and overlap the next interval. Any leftovers are picked up (still
   * oldest-first) on the following pass.
   */
  async listPendingBillingOrgs(limit?: number): Promise<Array<{ orgId: string; planId: string }>> {
    const query = Organization.find({ pendingBillingPlanId: { $exists: true, $ne: null } })
      .select('_id pendingBillingPlanId pendingBillingSince')
      .sort({ pendingBillingSince: 1 });
    if (limit && limit > 0) query.limit(limit);
    const orgs = await query.lean();
    return orgs.map((o) => ({ orgId: String(o._id), planId: String(o.pendingBillingPlanId) }));
  }

  /**
   * Resolve a User by email-or-username + verify the password.
   * Returns null on no-match or wrong password (controller responds 401).
   */
  async findByCredentials(identifier: string, password: string) {
    // `+isSuperAdmin` is needed because the schema marks the field
    // `select: false`; without an explicit opt-in the JWT issued from
    // this user object would never carry the sysadmin claim and a real
    // super-admin would silently lose privileges on login.
    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
    }).select('+password +tokenVersion +isSuperAdmin');

    if (!user || !(await user.comparePassword(password))) return null;
    return user;
  }

  /**
   * Atomically swap the user's refresh-token hash. Returns the user if the
   * old hash matched (rotation succeeded), null otherwise (token was reused
   * or stolen — caller should invalidate all sessions).
   */
  async rotateRefreshToken(userId: string, oldRefreshToken: string) {
    const oldHash = hashRefreshToken(oldRefreshToken);
    // `+isSuperAdmin` — refresh rotation reissues the access token via
    // `issueTokens(user)`, which reads `user.isSuperAdmin` to set the JWT
    // claim. Without the explicit opt-in (schema is `select: false`) every
    // refresh would silently downgrade a sysadmin.
    return User.findOne({ _id: userId, refreshToken: oldHash }).select('+refreshToken +tokenVersion +isSuperAdmin');
  }

  /**
   * Bump tokenVersion + clear refresh token to invalidate every active
   * session. Used on logout AND defensively on suspected refresh-token reuse.
   */
  async invalidateAllSessions(userId: string): Promise<void> {
    await User.updateOne(
      { _id: userId },
      { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
    );
    // Post-commit: publish the user's now-current tokenVersion so the stateless
    // services reject outstanding tokens immediately (best-effort).
    await publishUserRevocation(userId);
  }

  /**
   * Verify the user has an active membership in the target org and update
   * their `lastActiveOrgId`. Returns the user (with tokenVersion selected
   * for re-issuing tokens) on success, or null when membership doesn't
   * exist / is inactive.
   */
  async switchActiveOrg(userId: string, organizationId: string) {
    // `organizationId` is a plain ObjectId field; `organizationId` arrives here
    // as a hex string (route body), so cast it via toOrgId so the membership
    // filter matches the stored ObjectId.
    const membership = await UserOrganization.findOne({
      userId,
      organizationId: toOrgId(organizationId),
      isActive: true,
    }).lean();
    if (!membership) return null;

    // Refuse to make a SOFT-DELETED (tombstoned) org the active one — mirrors
    // the token chokepoint (`resolveMembership`), which won't scope a token to a
    // dying org. Without this the caller could set `lastActiveOrgId` to a
    // tombstoned org, then every subsequent token issue would fall back off it
    // (a dangling pointer) instead of the switch simply being rejected here.
    const org = await Organization.findById(toOrgId(organizationId)).select('deletedAt').lean();
    if (!org || (org as { deletedAt?: Date | null }).deletedAt) return null;

    await User.updateOne({ _id: userId }, { $set: { lastActiveOrgId: organizationId } });
    // `+isSuperAdmin` — switching orgs reissues a JWT and must preserve
    // the sysadmin claim. Schema marks the field `select: false`.
    return User.findById(userId).select('+tokenVersion +isSuperAdmin');
  }

  /**
   * Generate + persist an email-verification token for the user. Returns
   * the raw token (caller emails it to the user) or marks already-verified.
   */
  async createVerificationToken(userId: string): Promise<VerificationDispatch | null> {
    const user = await User.findById(userId).select('+emailVerificationToken +emailVerificationExpires');
    if (!user) return null;

    if (user.isEmailVerified) {
      return { rawToken: '', email: user.email, alreadyVerified: true };
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    user.emailVerificationToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.emailVerificationExpires = new Date(Date.now() + config.auth.verificationTokenTtlMs);
    await user.save();

    return { rawToken, email: user.email, alreadyVerified: false };
  }

  /**
   * OAuth login flow: find a user by their provider ID, fall back to
   * email-match (linking the OAuth account in that case), or auto-create
   * a fresh user with a personal org. Username generation strips
   * non-`[a-z0-9_-]` from the OAuth-supplied name/email and probes for
   * the first un-taken `<base><n>` form so concurrent OAuth registrations
   * don't collide.
   */
  async findOrCreateOAuthUser(
    providerName: string,
    userInfo: { id: string; email: string; name?: string; picture?: string },
    opts: { markOnboarding?: boolean } = {},
  ) {
    // `+isSuperAdmin` opts in to a schema field with `select: false`; the
    // returned user feeds JWT issuance and must carry the real flag.
    const byOAuth = await User.findOne({ [`oauth.${providerName}.id`]: userInfo.id }).select('+tokenVersion +isSuperAdmin');
    if (byOAuth) return byOAuth;

    const byEmail = await User.findOne({ email: userInfo.email.toLowerCase() }).select('+tokenVersion +isSuperAdmin');
    if (byEmail) {
      // Hardening: only auto-link a (provider-verified) social identity onto a
      // pre-existing account when that account's OWN email is verified. An
      // UNVERIFIED pre-existing account is an unproven email claim — silently
      // linking would let someone who plants an unverified password account on a
      // victim's address get the victim signed into it on their first social
      // login. Reject instead; the victim verifies (or resets) their existing
      // account first, then links. Verified accounts link seamlessly as before.
      if (!byEmail.isEmailVerified) throw new Error(ACCOUNT_EMAIL_UNVERIFIED);
      await User.updateOne({ _id: byEmail._id }, {
        $set: { [`oauth.${providerName}`]: { id: userInfo.id, email: userInfo.email, name: userInfo.name, picture: userInfo.picture, linkedAt: new Date() } },
      });
      return byEmail;
    }

    const baseUsername = (userInfo.name || userInfo.email.split('@')[0])
      .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    let username = baseUsername;
    let suffix = 1;
    // The OAuth-created org's name is derived from `username`. SECURITY: reserve
    // the well-known `system` slug so a federated identity that normalizes to
    // 'system' can never auto-create/claim the privileged system org (which would
    // flag the user `isSuperAdmin`). Unless the email is operator-authorized
    // (BOOTSTRAP_SUPERADMIN_EMAILS), treat 'system' as unavailable — the probe
    // loop folds it to a namespaced `system<n>`, so the privileged branch below
    // stays unreachable for self-serve callers.
    const emailAuthorizedForSystemOrg = isBootstrapSuperAdminEmail(userInfo.email);
    while (
      await User.exists({ username })
      || (username.toLowerCase() === SYSTEM_ORG_SLUG && !emailAuthorizedForSystemOrg)
    ) {
      username = `${baseUsername}${suffix++}`;
    }

    const newUser = new User({
      username,
      email: userInfo.email.toLowerCase(),
      isEmailVerified: true,
      // First social signup collected no org name / plan, so flag the user for
      // the onboarding screen. SSO callers pass `markOnboarding: false` — their
      // users sign in to an enforced org, not a self-named personal one.
      needsOnboarding: opts.markOnboarding !== false,
      tokenVersion: 0,
      oauth: { [providerName]: { id: userInfo.id, email: userInfo.email, name: userInfo.name, picture: userInfo.picture, linkedAt: new Date() } },
    });

    // Auto-create personal org + owner membership + default Roles in a single
    // transaction (mirrors register()): a partial apply would leave an org with
    // no owner membership or no permission Roles. `save()` happens inside the
    // tx so the whole identity lands atomically.
    await withMongoTransaction(async (session) => {
      // Same well-known-slug handling as register() (via the shared helper): if
      // the derived org name is 'system', create it as the system tenant. The
      // username-probe loop above already folded 'system' to a namespaced form
      // for any non-operator-authorized email, so this can only be true for an
      // operator-authorized bootstrap identity.
      const isSystemOrg = username.toLowerCase() === SYSTEM_ORG_SLUG;
      // Pin the onboarding rename target only for the social-signup path (same
      // condition as needsOnboarding); SSO/system paths don't rename later.
      await this.provisionOwnerOrg(newUser, { name: username, isSystemOrg, markOnboardingOrg: opts.markOnboarding !== false }, session);
    });

    return newUser;
  }

  /**
   * Finish first-run onboarding for a social-signup user: optionally rename the
   * auto-created personal org, then clear `needsOnboarding`. Plan provisioning
   * (billing) is fire-and-forget in the controller, mirroring register().
   *
   * This is a FIRST-RUN endpoint, not a general rename route — it no-ops once the
   * user is already onboarded (the canonical rename is `PATCH /organization/:id
   * /identity` behind the full `org:settings` guard). Only the org owner/admin
   * may rename; a mere member's rename is skipped (the flag still clears so the
   * user isn't stuck). Idempotent.
   *
   * The rename is a direct `org.save()`: the model's `pre('validate')` hook
   * regenerates + de-duplicates the slug, so — exactly like register() —
   * duplicate org NAMES are allowed (only slugs are unique). The reserved
   * `system` name is refused for non-operator emails, matching register() /
   * findOrCreateOAuthUser.
   *
   * Throws `ONBOARDING_USER_NOT_FOUND` / `ONBOARDING_NO_ORG` / `RESERVED_ORG_NAME`.
   */
  async completeOnboarding(
    userId: string,
    input: { organizationName?: string } = {},
  ): Promise<{ organizationId: string; organizationName: string }> {
    const user = await User.findById(userId);
    if (!user) throw new Error(ONBOARDING_USER_NOT_FOUND);
    // Rename the org auto-provisioned at signup — NOT whatever `lastActiveOrgId`
    // is now (the user may have switched active org before finishing onboarding).
    const orgId = user.onboardingOrgId || user.lastActiveOrgId;
    if (!orgId) throw new Error(ONBOARDING_NO_ORG);

    const org = await Organization.findById(orgId);
    if (!org) throw new Error(ONBOARDING_NO_ORG);

    // First-run only: once onboarded, return the current org unchanged so this
    // can't be used as an alternate, less-guarded org-rename route.
    if (!user.needsOnboarding) {
      return { organizationId: orgId, organizationName: org.name };
    }

    const desired = input.organizationName?.trim();
    if (desired && desired !== org.name) {
      // Reserve the well-known `system` name for operator-authorized emails only
      // — the same invariant register()/findOrCreateOAuthUser enforce, so a
      // personal org can't be renamed to `system` (which isSystemOrgId matches
      // by name, misclassifying the tenant).
      if (desired.toLowerCase() === SYSTEM_ORG_SLUG && !isBootstrapSuperAdminEmail(user.email)) {
        throw new Error(RESERVED_ORG_NAME);
      }
      const membership = await UserOrganization
        .findOne({ userId: user._id, organizationId: orgId, isActive: true })
        .select('role').lean();
      if (membership?.role === 'owner' || membership?.role === 'admin') {
        // Direct save: the pre('validate') hook regenerates + de-duplicates the
        // slug, so duplicate names are accepted (parity with register()).
        org.name = desired;
        await org.save();
      }
    }

    user.needsOnboarding = false;
    await user.save();

    return { organizationId: orgId, organizationName: org.name };
  }

  /**
   * Look up a user by the hash of the supplied verification token, mark
   * them verified, and clear the token fields. Returns the user on
   * success, null when the token is invalid or expired.
   */
  async verifyEmailWithToken(rawToken: string) {
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: new Date() },
    }).select('+emailVerificationToken +emailVerificationExpires');

    if (!user) return null;

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();
    logger.info('Email verified', { userId: user._id.toString(), email: user.email });
    return user;
  }

  /**
   * Directly mark a user's email verified WITHOUT the token round-trip — used by
   * the admin/superadmin self-verify action so a privileged operator can skip the
   * resend + click-link flow (e.g. in an environment with no outbound email).
   * Idempotent; returns the user, or `null` when the id doesn't resolve.
   */
  async markEmailVerifiedById(userId: string) {
    const user = await User.findById(userId).select('+emailVerificationToken +emailVerificationExpires');
    if (!user) return null;
    if (!user.isEmailVerified) {
      user.isEmailVerified = true;
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;
      await user.save();
      logger.info('Email marked verified directly (admin self-verify)', {
        userId: user._id.toString(), email: user.email,
      });
    }
    return user;
  }
}

export const authService = new AuthService();

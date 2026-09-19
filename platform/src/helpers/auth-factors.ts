// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ways a signed-in user can prove themselves again (step-up factors).
 *
 * Reported on GET /user/profile as `authFactors` so the step-up modal offers
 * only what the user actually has, and re-checked by the re-auth controller
 * (controllers/step-up-reauth.ts) so a client can't start a re-auth through a
 * provider the account isn't linked to.
 *
 *   - password     — the account has a password hash (email/password signup).
 *   - oauth        — a linked social identity whose provider is still configured,
 *                    unless the email is SSO-enforced (sign-in would refuse it).
 *   - sso          — a linked org-IdP identity (stored with its issuer) for an org
 *                    the user belongs to (or whose domain enforces SSO for them)
 *                    that has SSO enabled + entitled. Never for platform admins,
 *                    who can't sign in through a tenant IdP either. OIDC only:
 *                    a SAML org is not a step-up factor in this release (#4) —
 *                    see `ssoOptions` for why.
 *   - passkeyCount — how many WebAuthn credentials the account has registered.
 *                    Non-zero means the modal can offer "Use a passkey" (and the
 *                    security page can offer to remove one).
 *   - hasTotp      — a CONFIRMED authenticator-app enrolment. An enrolment that
 *                    was started and never activated is not a factor and must
 *                    not be offered, so the check is on `activatedAt`, not on
 *                    the row's existence.
 */

import { type Types } from 'mongoose';
import { User } from '../models/index.js';
import { OAUTH_PROVIDER_NAMES } from '../types/oauth-provider.js';

/**
 * Everything beyond "does this account have a password" is loaded ON DEMAND:
 * `GET /user/profile` imports this module on every call, while the provider side
 * pulls in the deployment's OAuth config and — for SSO — the enforcement policy,
 * entitlements and the org-IdP service with its KMS-backed secret handling.
 * Only an account that actually has a linked identity pays for that.
 */
async function providerDeps() {
  const [enforcement, models, oauthConfig] = await Promise.all([
    import('./sso-enforcement.js'),
    import('../models/index.js'),
    import('./oauth-config.js'),
  ]);
  return {
    ...enforcement,
    isOAuthProviderEnabled: oauthConfig.isOAuthProviderEnabled,
    OrgIdpConfig: models.OrgIdpConfig,
    Organization: models.Organization,
    UserOrganization: models.UserOrganization,
  };
}

/** One provider the user can re-authenticate with. */
export type ReauthOption =
  | { type: 'oauth'; provider: string }
  | { type: 'sso'; provider: string; orgId: string; orgName?: string };

export interface AuthFactors {
  hasPassword: boolean;
  passkeyCount: number;
  hasTotp: boolean;
  /** Sign-in providers usable for step-up re-auth. */
  providers: ReauthOption[];
}

/** A linked identity as stored under `User.oauth.<provider>`. */
export interface LinkedIdentity {
  id: string;
  issuer?: string;
}

/** The user fields factor resolution reads. */
export interface FactorUser {
  _id: Types.ObjectId;
  email: string;
  hasPassword: boolean;
  isSuperAdmin: boolean;
  oauth: Record<string, LinkedIdentity | undefined>;
}

/** Load the fields {@link resolveAuthFactors} needs. The password hash is read
 *  only to derive `hasPassword` and never leaves this function. */
export async function loadFactorUser(userId: string): Promise<FactorUser | null> {
  const doc = await User.findById(userId).select('+password +isSuperAdmin email oauth').lean() as {
    _id: Types.ObjectId;
    email: string;
    password?: string;
    isSuperAdmin?: boolean;
    oauth?: Record<string, LinkedIdentity | undefined>;
  } | null;
  if (!doc) return null;
  return {
    _id: doc._id,
    email: doc.email,
    hasPassword: typeof doc.password === 'string' && doc.password.length > 0,
    isSuperAdmin: doc.isSuperAdmin === true,
    oauth: doc.oauth ?? {},
  };
}

const SOCIAL_PROVIDERS = new Set<string>(OAUTH_PROVIDER_NAMES);

/** Social links usable for re-auth: a named social provider that is configured,
 *  linked by social sign-in (no issuer) or by Google SSO (same Google subject). */
function socialOptions(
  user: FactorUser,
  googleIssuer: string,
  isOAuthProviderEnabled: (name: string) => boolean,
): ReauthOption[] {
  return Object.entries(user.oauth)
    .filter(([name, link]) => SOCIAL_PROVIDERS.has(name) && !!link?.id
      && (!link.issuer || link.issuer === googleIssuer)
      && isOAuthProviderEnabled(name))
    .map(([name]) => ({ type: 'oauth' as const, provider: name }));
}

/** SSO orgs whose enabled + entitled IdP matches a linked SSO identity. */
async function ssoOptions(
  user: FactorUser,
  enforcedOrgId: string | undefined,
  deps: Awaited<ReturnType<typeof providerDeps>>,
): Promise<ReauthOption[]> {
  if (user.isSuperAdmin) return [];
  const ssoLinked = Object.entries(user.oauth).filter(([, link]) => !!link?.id && !!link.issuer);
  if (ssoLinked.length === 0) return [];
  const { Organization, OrgIdpConfig, UserOrganization, isSsoEntitled } = deps;

  const memberships = await UserOrganization.find({ userId: user._id }).select('organizationId').lean() as Array<{ organizationId: unknown }>;
  const orgIds = [...new Set([...memberships.map(m => String(m.organizationId)), ...(enforcedOrgId ? [enforcedOrgId] : [])])];
  if (orgIds.length === 0) return [];

  const configs = await OrgIdpConfig.find({ orgId: { $in: orgIds }, enabled: true }).select('orgId provider protocol').lean() as Array<{ orgId: string; provider?: string; protocol?: string }>;
  const linkedProviders = new Set(ssoLinked.map(([name]) => name));
  // SAML is deliberately NOT a step-up factor in this release (#4): step-up
  // needs a FRESH, provable re-authentication, and the SAML flow lands on a
  // server ACS rather than in the popup the re-auth ceremony reads from. A
  // SAML-only account steps up with a passkey, an authenticator app, or a
  // password — see docs/authentication.md. Filtering here is what keeps the
  // step-up modal from offering a button that could only ever fail.
  const candidates = configs.filter(c => c.protocol !== 'saml' && !!c.provider && linkedProviders.has(c.provider));
  if (candidates.length === 0) return [];

  const orgs = await Organization.find({ _id: { $in: candidates.map(c => c.orgId) } }).select('_id name').lean() as Array<{ _id: unknown; name?: string }>;
  const names = new Map(orgs.map(o => [String(o._id), o.name]));

  const options: ReauthOption[] = [];
  for (const c of candidates) {
    if (!(await isSsoEntitled(String(c.orgId)))) continue;
    const orgName = names.get(String(c.orgId));
    options.push({ type: 'sso', provider: c.provider!, orgId: String(c.orgId), ...(orgName && { orgName }) });
  }
  return options;
}

/** Count the account's registered passkeys. Lazily imported for the same reason
 *  as {@link providerDeps}: a plain profile read shouldn't pull in the WebAuthn
 *  model graph just to learn the answer is 0 for most accounts. */
async function passkeyCountOf(userId: Types.ObjectId): Promise<number> {
  const { WebAuthnCredential } = await import('../models/index.js');
  return WebAuthnCredential.countDocuments({ userId });
}

/** Whether the account has a CONFIRMED authenticator-app enrolment. Read through
 *  the model directly (not `totp-service.hasActiveTotp`) for the same reason as
 *  {@link passkeyCountOf}: a plain profile read shouldn't pull the enrolment
 *  service — and with it the secret-encryption and SSO-enforcement graphs — in
 *  just to learn the answer is `false` for most accounts. */
async function totpActiveFor(userId: Types.ObjectId): Promise<boolean> {
  const { UserTotp } = await import('../models/index.js');
  return !!(await UserTotp.exists({ userId, activatedAt: { $ne: null } }));
}

/** Resolve the user's step-up factors (see the module doc for the rules). */
export async function resolveAuthFactors(user: FactorUser): Promise<AuthFactors> {
  const [passkeyCount, hasTotp] = await Promise.all([passkeyCountOf(user._id), totpActiveFor(user._id)]);
  const hasLinks = Object.values(user.oauth).some(link => !!link?.id);
  if (!hasLinks) {
    return { hasPassword: user.hasPassword, passkeyCount, hasTotp, providers: [] };
  }

  const deps = await providerDeps();
  const enforcement = await deps.findSsoEnforcementForEmail(user.email);
  const providers: ReauthOption[] = [
    // Sign-in refuses a social grant for an SSO-enforced email, so re-auth does too.
    ...(enforcement ? [] : socialOptions(user, deps.GOOGLE_ISSUER, deps.isOAuthProviderEnabled)),
    ...(await ssoOptions(user, enforcement?.orgId, deps)),
  ];
  return { hasPassword: user.hasPassword, passkeyCount, hasTotp, providers };
}

/** Whether `option` is one of the user's current re-auth options. */
export function findReauthOption(factors: AuthFactors, requested: { type: 'oauth'; provider: string } | { type: 'sso'; orgId: string }): ReauthOption | undefined {
  return factors.providers.find(p => requested.type === 'oauth'
    ? p.type === 'oauth' && p.provider === requested.provider
    : p.type === 'sso' && p.orgId === requested.orgId);
}

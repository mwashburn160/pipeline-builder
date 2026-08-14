// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { rejectIfSsoEnforced } from '../helpers/sso-enforcement.js';
import { incCounter } from '../observability/metrics.js';
import { authService } from '../services/index.js';
import { type OAuthProviderName } from '../types/oauth-provider.js';
import { issueTokens } from '../utils/token.js';
import { validateBody, oauthCallbackSchema } from '../utils/validation.js';

const logger = createLogger('oauth-controller');

// OAuth State (CSRF protection)

/** Cap on the in-memory OAuth state fallback. Each entry is ~80 bytes; default
 *  1000 caps memory at ~80 KB. Override via `OAUTH_MAX_PENDING_STATES`. */
const MAX_PENDING_STATES = parseInt(process.env.OAUTH_MAX_PENDING_STATES || '1000', 10);

// Cross-pod pending-state store (env Redis; process-local Map fallback). Each
// state is bound to the provider that minted it so a state issued for one
// provider can't be replayed on another provider's callback. Backing this with
// Redis is what lets the initiate + callback land on different replicas — with
// the old process-local Map, login failed ~80% of the time at maxReplicas: 5.
const pendingOAuthStates = createPendingStateStore<{ provider: string; createdAt: number }>({
  prefix: 'oauth:state:',
  ttlMs: config.oauth.stateTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: MAX_PENDING_STATES,
});

// Types

export interface OAuthUserInfo {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

interface OAuthProvider {
  enabled: boolean;
  buildAuthorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
  fetchUserInfo(accessToken: string): Promise<OAuthUserInfo>;
}

// Google provider

function createGoogleProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.google;
  const callbackUrl = `${config.oauth.callbackBaseUrl}/auth/callback/google`;

  return {
    enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
        state,
      });
      return `${authorizeUrl}?${params}`;
    },
    async exchangeCode(code: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      });
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: params.toString(),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || !data.access_token) throw new Error('TOKEN_EXCHANGE_FAILED');
      return data.access_token as string;
    },
    async fetchUserInfo(accessToken: string) {
      const res = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error('Failed to fetch Google user info');
      const data = await res.json() as Record<string, unknown>;
      // Only trust the email for account lookup/linking when Google confirms it
      // is verified — an unverified (attacker-controllable) Google email would
      // otherwise auto-link to and take over a pre-existing local account.
      // Mirrors the GitHub path, which likewise enforces a verified email
      // (resolved from `/user/emails`; the plain `/user` profile email is not
      // trusted). (OIDC userinfo → `email_verified`; legacy oauth2/v2 → `verified_email`.)
      const emailVerified = data.email_verified === true || data.verified_email === true;
      if (!data.email || !emailVerified) {
        throw new Error('Google did not return a verified email address');
      }
      return { id: data.id as string, email: data.email as string, name: data.name as string | undefined, picture: data.picture as string | undefined };
    },
  };
}

// GitHub provider

function createGitHubProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.github;
  const callbackUrl = `${config.oauth.callbackBaseUrl}/auth/callback/github`;

  return {
    enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        scope: 'read:user user:email',
        state,
      });
      return `${authorizeUrl}?${params}`;
    },
    async exchangeCode(code: string) {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || !data.access_token) throw new Error('TOKEN_EXCHANGE_FAILED');
      return data.access_token as string;
    },
    async fetchUserInfo(accessToken: string) {
      const profileRes = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (!profileRes.ok) throw new Error('Failed to fetch GitHub user info');
      const profile = await profileRes.json() as Record<string, unknown>;

      // Never trust the plain `/user` profile email: GitHub returns it even
      // when the address is unverified, and downstream `findOrCreateOAuthUser`
      // auto-links this email onto a pre-existing local account — an unverified
      // value is therefore an account-takeover surface. Resolve the email
      // exclusively from `/user/emails`, requiring a `verified: true` entry and
      // preferring the `primary` one (fall back to any verified address).
      // Mirrors the Google path, which likewise only accepts a verified email.
      const emailsUrl = userinfoUrl.replace(/\/user$/, '/user/emails');
      const emailsRes = await fetch(emailsUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      let email: string | null = null;
      if (emailsRes.ok) {
        const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primaryVerified = emails.find(e => e.verified && e.primary);
        email = primaryVerified?.email || emails.find(e => e.verified)?.email || null;
      }
      if (!email) throw new Error('GitHub did not return a verified email address');

      return { id: String(profile.id), email, name: profile.name as string | undefined, picture: profile.avatar_url as string | undefined };
    },
  };
}

// Facebook provider
//
// Facebook Login is OAuth2 but NOT standards-OIDC (no discovery/JWKS/id_token),
// so — like Google/GitHub — it gets a dedicated handler rather than riding the
// generic-oidc IdP path. User info comes from the Graph API `/me` endpoint.

function createFacebookProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.facebook;
  const callbackUrl = `${config.oauth.callbackBaseUrl}/auth/callback/facebook`;

  return {
    enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        // Facebook scopes are comma-separated. `email` is required for account
        // linking; the user can still decline it at the consent screen (handled below).
        scope: 'email,public_profile',
        state,
      });
      return `${authorizeUrl}?${params}`;
    },
    async exchangeCode(code: string) {
      // Graph token endpoint accepts the params as a query string and returns JSON.
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      });
      const res = await fetch(`${tokenUrl}?${params}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || !data.access_token) throw new Error('TOKEN_EXCHANGE_FAILED');
      return data.access_token as string;
    },
    async fetchUserInfo(accessToken: string) {
      // Graph `/me` with an explicit field list. Facebook only returns an email it
      // has itself verified, so a returned address is trustworthy for linking — but
      // it is OMITTED when the user declined the `email` scope or the account has
      // no confirmed email, which we must reject rather than link a blank identity.
      const params = new URLSearchParams({ fields: 'id,name,email', access_token: accessToken });
      const res = await fetch(`${userinfoUrl}?${params}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Failed to fetch Facebook user info');
      const data = await res.json() as Record<string, unknown>;
      if (!data.email) {
        throw new Error('Facebook did not return an email address (the user may have declined the email permission)');
      }
      const picture = ((data.picture as { data?: { url?: string } } | undefined)?.data?.url) ?? undefined;
      return { id: String(data.id), email: data.email as string, name: data.name as string | undefined, picture };
    },
  };
}

// Microsoft provider
//
// Entra/Azure AD v2 is standards-OIDC. Like Google, user info comes from the
// OIDC userinfo endpoint (Microsoft Graph `/oidc/userinfo`). The authorize/token
// URLs are tenant-scoped (`common` by default) — the `{tenant}` placeholder in
// the configured URLs is substituted at construction time.

function createMicrosoftProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl: authorizeTpl, tokenUrl: tokenTpl, userinfoUrl, tenant, enabled } = config.oauth.microsoft;
  const callbackUrl = `${config.oauth.callbackBaseUrl}/auth/callback/microsoft`;
  const authorizeUrl = authorizeTpl.replace('{tenant}', tenant);
  const tokenUrl = tokenTpl.replace('{tenant}', tenant);

  return {
    enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid email profile',
        response_mode: 'query',
        state,
      });
      return `${authorizeUrl}?${params}`;
    },
    async exchangeCode(code: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      });
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: params.toString(),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || !data.access_token) throw new Error('TOKEN_EXCHANGE_FAILED');
      return data.access_token as string;
    },
    async fetchUserInfo(accessToken: string) {
      const res = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error('Failed to fetch Microsoft user info');
      const data = await res.json() as Record<string, unknown>;
      // nOAuth mitigation. Microsoft Graph's OIDC `email` claim is a user-MUTABLE,
      // unverified directory attribute with no `email_verified` signal in userinfo.
      // In a SHARED tenant (`common`/`organizations`/`consumers`) an attacker can
      // bring their own Azure AD tenant, set that attribute to a victim's address,
      // and — because sign-in account-links by email — take over the victim's
      // account (the published "nOAuth" class). So the email is only trusted when
      // the operator has PINNED a specific tenant (OAUTH_MICROSOFT_TENANT = a
      // directory GUID or verified domain), where the tenant admin controls the
      // directory and cross-tenant injection is impossible. Refuse the shared
      // tenants rather than link an unverifiable identity. `preferred_username`
      // is likewise mutable and is never used as a link key.
      const shared = new Set(['common', 'organizations', 'consumers']);
      if (shared.has((tenant || 'common').toLowerCase())) {
        throw new Error('Microsoft SSO requires a pinned OAUTH_MICROSOFT_TENANT (directory GUID or verified domain); the shared "common" tenant is refused because its email claim is unverifiable (nOAuth)');
      }
      const email = data.email as string | undefined;
      if (!email) throw new Error('Microsoft did not return an email address');
      return { id: (data.sub ?? data.oid) as string, email, name: data.name as string | undefined, picture: data.picture as string | undefined };
    },
  };
}

// GitLab provider
//
// GitLab is standards-OIDC (also self-hostable). All endpoints derive from the
// configured base URL unless individually overridden. The OIDC userinfo endpoint
// supplies `email_verified`, which we require before linking.

function createGitLabProvider(): OAuthProvider {
  const { clientId, clientSecret, baseUrl, enabled } = config.oauth.gitlab;
  const authorizeUrl = config.oauth.gitlab.authorizeUrl || `${baseUrl}/oauth/authorize`;
  const tokenUrl = config.oauth.gitlab.tokenUrl || `${baseUrl}/oauth/token`;
  const userinfoUrl = config.oauth.gitlab.userinfoUrl || `${baseUrl}/oauth/userinfo`;
  const callbackUrl = `${config.oauth.callbackBaseUrl}/auth/callback/gitlab`;

  return {
    enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid email profile',
        state,
      });
      return `${authorizeUrl}?${params}`;
    },
    async exchangeCode(code: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      });
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: params.toString(),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || !data.access_token) throw new Error('TOKEN_EXCHANGE_FAILED');
      return data.access_token as string;
    },
    async fetchUserInfo(accessToken: string) {
      const res = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error('Failed to fetch GitLab user info');
      const data = await res.json() as Record<string, unknown>;
      // GitLab's OIDC userinfo emits `email_verified`; require it before linking
      // the address onto a pre-existing local account (account-takeover guard,
      // mirroring the Google path).
      if (!data.email || data.email_verified !== true) {
        throw new Error('GitLab did not return a verified email address');
      }
      return { id: String(data.sub), email: data.email as string, name: data.name as string | undefined, picture: data.picture as string | undefined };
    },
  };
}

// LinkedIn provider
//
// "Sign in with LinkedIn using OpenID Connect" — standards-OIDC. User info comes
// from the OIDC userinfo endpoint. LinkedIn only returns emails it has verified;
// it also emits `email_verified` (a string "true"/"false" in some responses),
// which we honour when present.

function createLinkedInProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.linkedin;
  const callbackUrl = `${config.oauth.callbackBaseUrl}/auth/callback/linkedin`;

  return {
    enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid email profile',
        state,
      });
      return `${authorizeUrl}?${params}`;
    },
    async exchangeCode(code: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      });
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: params.toString(),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || !data.access_token) throw new Error('TOKEN_EXCHANGE_FAILED');
      return data.access_token as string;
    },
    async fetchUserInfo(accessToken: string) {
      const res = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error('Failed to fetch LinkedIn user info');
      const data = await res.json() as Record<string, unknown>;
      // LinkedIn only returns emails it has verified, so a returned address is
      // trustworthy; when `email_verified` is present (bool or string form) we
      // still honour it and reject a false value. A missing email is rejected.
      const verified = data.email_verified === undefined
        || data.email_verified === true
        || data.email_verified === 'true';
      if (!data.email || !verified) {
        throw new Error('LinkedIn did not return a verified email address');
      }
      return { id: String(data.sub), email: data.email as string, name: data.name as string | undefined, picture: data.picture as string | undefined };
    },
  };
}

// Provider registry — keyed by the shared `OAuthProviderName` union
// (src/types/oauth-provider.ts) rather than a locally-redeclared alias.

const providers: Record<OAuthProviderName, OAuthProvider> = {
  google: createGoogleProvider(),
  github: createGitHubProvider(),
  facebook: createFacebookProvider(),
  microsoft: createMicrosoftProvider(),
  gitlab: createGitLabProvider(),
  linkedin: createLinkedInProvider(),
};

function getProvider(name: string): OAuthProvider | null {
  return providers[name as OAuthProviderName] ?? null;
}

// Shared verification

/**
 * Typed OAuth error → HTTP status map. Shared by the login callback and the
 * OAuth invitation-accept flow so both surface identical, correct statuses.
 */
export const OAUTH_ERROR_MAP = {
  OAUTH_UNSUPPORTED_PROVIDER: { status: 400, message: 'Unsupported OAuth provider' },
  OAUTH_PROVIDER_DISABLED: { status: 400, message: 'OAuth provider is not configured' },
  OAUTH_INVALID_STATE: { status: 403, message: 'Invalid or expired OAuth state' },
  OAUTH_NO_EMAIL: { status: 400, message: 'OAuth provider did not return an email address' },
  TOKEN_EXCHANGE_FAILED: { status: 502, message: 'Failed to exchange authorization code' },
} as const;

/**
 * Validate the one-time CSRF `state`, exchange the authorization `code` with the
 * provider, and return the provider-VERIFIED identity (id + verified email).
 *
 * This is the ONLY trustworthy source of an OAuth identity — every flow (login
 * callback AND invitation-accept) must go through it. Accepting a client-supplied
 * profile instead would let a caller assert any identity. Consumes the state on
 * any lookup (valid or mismatched) to prevent probing/replay. Throws typed
 * errors from {@link OAUTH_ERROR_MAP}; callers wire that map into withController.
 */
export async function verifyOAuthCode(providerName: string, code: string, state: string): Promise<OAuthUserInfo> {
  const provider = getProvider(providerName);
  if (!provider) throw new Error('OAUTH_UNSUPPORTED_PROVIDER');
  if (!provider.enabled) throw new Error('OAUTH_PROVIDER_DISABLED');

  // Consume-once: the store deletes the entry on lookup (valid or mismatched)
  // to prevent probing/replay — same semantics as the old in-memory map.
  const pending = await pendingOAuthStates.consume(state);
  if (!pending || pending.provider !== providerName) throw new Error('OAUTH_INVALID_STATE');

  const accessToken = await provider.exchangeCode(code);
  const userInfo = await provider.fetchUserInfo(accessToken);
  if (!userInfo.email) throw new Error('OAUTH_NO_EMAIL');
  return userInfo;
}

// Route handlers

export const getAuthUrl = withController('Get OAuth URL', async (req, res) => {
  const providerName = getParam(req.params, 'provider')!;
  const provider = getProvider(providerName);

  if (!provider) return sendError(res, 400, `Unsupported OAuth provider: ${providerName}`);
  if (!provider.enabled) return sendError(res, 400, `${providerName} OAuth is not configured`);

  const state = crypto.randomBytes(32).toString('hex');
  await pendingOAuthStates.put(state, { provider: providerName, createdAt: Date.now() });

  sendSuccess(res, 200, { url: provider.buildAuthorizeUrl(state), state });
});

export const handleCallback = withController('OAuth callback', async (req, res) => {
  const providerName = getParam(req.params, 'provider')!;

  const body = validateBody(oauthCallbackSchema, req.body, res);
  if (!body) return;

  // Mirror the password-login audit surface (controllers/auth.ts login): a
  // failed OAuth grant (bad/expired state, failed code exchange, no verified
  // email) is a security-relevant auth failure — record it + bump the failed
  // counter, then rethrow so withController maps the typed error to its HTTP
  // status. Fire-and-forget audit: it never changes the request outcome.
  let userInfo;
  try {
    userInfo = await verifyOAuthCode(providerName, body.code, body.state);
  } catch (err) {
    audit(req, 'user.login.failed', { targetType: 'user', outcome: 'failure', details: { provider: providerName, method: 'oauth' } });
    incCounter('platform_logins_failed_total');
    throw err;
  }

  // Close the social-login SSO bypass: a user whose email domain is covered by
  // an ENABLED + `sso`-entitled org IdP MUST authenticate through that IdP, so a
  // social OAuth grant for that address is a bypass of the org's enforced SSO.
  // Mirror the password-login gate (controllers/auth.ts) — reject with the same
  // typed SSO_REQUIRED + {orgId, provider} so the UI can route into SSO.
  if (await rejectIfSsoEnforced(res, userInfo.email)) return;

  const user = await authService.findOrCreateOAuthUser(providerName, userInfo);
  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString());

  // Success login audit — mirrors auth.ts login: the authenticated user is the
  // `targetId` (there is no `req.user` on the callback yet, exactly like the
  // password-login endpoint). Counter feeds the Platform Overview dashboard.
  audit(req, 'user.login', { targetType: 'user', targetId: user._id.toString() });
  incCounter('platform_logins_total');

  logger.info(`[OAUTH] ${providerName} login successful`, { userId: user._id, email: userInfo.email });
  sendSuccess(res, 200, tokens);
}, OAUTH_ERROR_MAP);

export const getProviders = withController('Get OAuth providers', async (_req, res) => {
  const enabled = Object.entries(providers).filter(([, p]) => p.enabled).map(([name]) => name);
  sendSuccess(res, 200, { providers: enabled });
});

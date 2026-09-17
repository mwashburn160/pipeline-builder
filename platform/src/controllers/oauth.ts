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
import {
  ACCOUNT_EMAIL_UNVERIFIED,
  OAUTH_EMAIL_UNVERIFIED,
  OAUTH_INVALID_STATE,
  OAUTH_MICROSOFT_TENANT_NOT_PINNED,
  OAUTH_NO_EMAIL,
  OAUTH_PROVIDER_DISABLED,
  OAUTH_TOKEN_EXCHANGE_FAILED,
  OAUTH_UNSUPPORTED_PROVIDER,
  OAUTH_USERINFO_FAILED,
} from '../services/auth-errors.js';
import { authService } from '../services/index.js';
import { type OAuthProviderName } from '../types/oauth-provider.js';
import { issueTokens } from '../utils/token.js';
import { validateBody, oauthCallbackSchema } from '../utils/validation.js';

const logger = createLogger('oauth-controller');

// OAuth State (CSRF protection)

/** Cap on the in-memory OAuth state fallback. Each entry is ~80 bytes; default
 *  1000 caps memory at ~80 KB. */
const MAX_PENDING_STATES = config.oauth.maxPendingStates;

// Cross-pod pending-state store (env Redis; process-local Map fallback). Each
// state is bound to the provider that minted it so a state issued for one
// provider can't be replayed on another provider's callback. Backing this with
// Redis is what lets the initiate + callback land on different replicas — with
// the old process-local Map, login failed ~80% of the time at maxReplicas: 5.
const pendingOAuthStates = createPendingStateStore<{ provider: string }>({
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

const callbackUrlFor = (provider: OAuthProviderName) => `${config.oauth.callbackBaseUrl}/auth/callback/${provider}`;

/**
 * Parse a provider response as JSON, mapping a transport failure, a non-2xx or
 * an unparseable body to the typed `failureCode` — a provider outage is a 502,
 * not an unhandled 500.
 */
async function providerJson<T>(request: () => Promise<Response>, failureCode: string): Promise<T> {
  let res: Response;
  try {
    res = await request();
  } catch {
    throw new Error(failureCode);
  }
  if (!res.ok) throw new Error(failureCode);
  try {
    return await res.json() as T;
  } catch {
    throw new Error(failureCode);
  }
}

/** Pull `access_token` out of a token-endpoint response. */
function accessTokenFrom(data: Record<string, unknown>): string {
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error(OAUTH_TOKEN_EXCHANGE_FAILED);
  return data.access_token;
}

/** RFC 6749 authorization-code exchange: form-encoded POST, JSON response. */
async function formTokenExchange(tokenUrl: string, fields: Record<string, string>): Promise<string> {
  const data = await providerJson<Record<string, unknown>>(() => fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ ...fields, grant_type: 'authorization_code' }).toString(),
  }), OAUTH_TOKEN_EXCHANGE_FAILED);
  return accessTokenFrom(data);
}

/** Bearer GET against a user-info endpoint. */
function fetchBearerJson<T>(url: string, accessToken: string): Promise<T> {
  return providerJson<T>(
    () => fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }),
    OAUTH_USERINFO_FAILED,
  );
}

/**
 * The email a provider returned, only when it vouches for it. Account linking
 * keys on the email, so an unverified (attacker-controllable) address would let
 * a sign-in take over a pre-existing local account.
 */
function requireVerifiedEmail(email: unknown, verified: boolean): string {
  if (typeof email !== 'string' || !email) throw new Error(OAUTH_NO_EMAIL);
  if (!verified) throw new Error(OAUTH_EMAIL_UNVERIFIED);
  return email;
}

/**
 * A standards-OIDC provider: authorization-code flow with the `openid email
 * profile` scope, a form-encoded token exchange, and a Bearer userinfo call.
 * Only the endpoints, extra authorize params and the claim → identity mapping
 * differ per provider.
 */
function createOidcStyleProvider(opts: {
  name: OAuthProviderName;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  extraAuthorizeParams?: Record<string, string>;
  /** Refuse before any userinfo call (e.g. a configuration that can't be trusted). */
  preflight?: () => void;
  toUserInfo: (claims: Record<string, unknown>) => OAuthUserInfo;
}): OAuthProvider {
  const callbackUrl = callbackUrlFor(opts.name);
  return {
    enabled: opts.enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: 'openid email profile',
        ...opts.extraAuthorizeParams,
        state,
      });
      return `${opts.authorizeUrl}?${params}`;
    },
    exchangeCode(code: string) {
      return formTokenExchange(opts.tokenUrl, {
        client_id: opts.clientId, client_secret: opts.clientSecret, code, redirect_uri: callbackUrl,
      });
    },
    async fetchUserInfo(accessToken: string) {
      opts.preflight?.();
      return opts.toUserInfo(await fetchBearerJson<Record<string, unknown>>(opts.userinfoUrl, accessToken));
    },
  };
}

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// Google provider

function createGoogleProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.google;
  return createOidcStyleProvider({
    name: 'google',
    enabled,
    clientId,
    clientSecret,
    authorizeUrl,
    tokenUrl,
    userinfoUrl,
    extraAuthorizeParams: { access_type: 'offline', prompt: 'select_account' },
    // OIDC userinfo → `email_verified`; legacy oauth2/v2 → `verified_email`.
    toUserInfo: (d) => ({
      id: String(d.id ?? d.sub),
      email: requireVerifiedEmail(d.email, d.email_verified === true || d.verified_email === true),
      name: optionalString(d.name),
      picture: optionalString(d.picture),
    }),
  });
}

// GitHub provider
//
// OAuth2 with a JSON token exchange; the email comes from `/user/emails`.

function createGitHubProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.github;
  const callbackUrl = callbackUrlFor('github');

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
      const data = await providerJson<Record<string, unknown>>(() => fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl }),
      }), OAUTH_TOKEN_EXCHANGE_FAILED);
      return accessTokenFrom(data);
    },
    async fetchUserInfo(accessToken: string) {
      const profile = await fetchBearerJson<Record<string, unknown>>(userinfoUrl, accessToken);

      // Never trust the plain `/user` profile email: GitHub returns it even
      // when the address is unverified. Resolve the email exclusively from
      // `/user/emails`, requiring a `verified: true` entry and preferring the
      // `primary` one (fall back to any verified address).
      const emails = await fetchBearerJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
        userinfoUrl.replace(/\/user$/, '/user/emails'), accessToken,
      );
      if (!Array.isArray(emails) || emails.length === 0) throw new Error(OAUTH_NO_EMAIL);
      const verified = emails.find((e) => e.verified && e.primary) ?? emails.find((e) => e.verified);
      const email = requireVerifiedEmail(verified?.email ?? emails[0].email, verified !== undefined);

      return { id: String(profile.id), email, name: optionalString(profile.name), picture: optionalString(profile.avatar_url) };
    },
  };
}

// Facebook provider
//
// Facebook Login is OAuth2 but NOT standards-OIDC (no discovery/JWKS/id_token),
// so it gets a dedicated handler. User info comes from the Graph API `/me`
// endpoint; the token endpoint takes its params as a query string.

function createFacebookProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.facebook;
  const callbackUrl = callbackUrlFor('facebook');

  return {
    enabled,
    buildAuthorizeUrl(state: string) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        // Facebook scopes are comma-separated. `email` is required for account
        // linking; the user can still decline it at the consent screen.
        scope: 'email,public_profile',
        state,
      });
      return `${authorizeUrl}?${params}`;
    },
    async exchangeCode(code: string) {
      const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl });
      const data = await providerJson<Record<string, unknown>>(
        () => fetch(`${tokenUrl}?${params}`, { method: 'GET', headers: { Accept: 'application/json' } }),
        OAUTH_TOKEN_EXCHANGE_FAILED,
      );
      return accessTokenFrom(data);
    },
    async fetchUserInfo(accessToken: string) {
      // Facebook only returns an email it has itself verified, so a returned
      // address is trustworthy — but it is OMITTED when the user declined the
      // `email` scope or the account has no confirmed email.
      const params = new URLSearchParams({ fields: 'id,name,email', access_token: accessToken });
      const data = await providerJson<Record<string, unknown>>(
        () => fetch(`${userinfoUrl}?${params}`, { headers: { Accept: 'application/json' } }),
        OAUTH_USERINFO_FAILED,
      );
      const picture = (data.picture as { data?: { url?: string } } | undefined)?.data?.url;
      return { id: String(data.id), email: requireVerifiedEmail(data.email, true), name: optionalString(data.name), picture };
    },
  };
}

// Microsoft provider
//
// Entra/Azure AD v2 is standards-OIDC. The authorize/token URLs are
// tenant-scoped — the `{tenant}` placeholder is substituted at construction time;
// userinfo is the tenant-agnostic Graph `/oidc/userinfo`.

const MICROSOFT_SHARED_TENANTS = new Set(['common', 'organizations', 'consumers']);

function createMicrosoftProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, tenant, enabled } = config.oauth.microsoft;
  return createOidcStyleProvider({
    name: 'microsoft',
    enabled,
    clientId,
    clientSecret,
    userinfoUrl,
    authorizeUrl: authorizeUrl.replace('{tenant}', tenant),
    tokenUrl: tokenUrl.replace('{tenant}', tenant),
    extraAuthorizeParams: { response_mode: 'query' },
    // nOAuth mitigation. Microsoft Graph's OIDC `email` claim is a user-MUTABLE,
    // unverified directory attribute with no `email_verified` signal. In a SHARED
    // tenant an attacker can bring their own Azure AD tenant, set that attribute
    // to a victim's address and — because sign-in links by email — take over the
    // victim's account. The email is only trusted when the operator has PINNED a
    // specific tenant (OAUTH_MICROSOFT_TENANT = a directory GUID or verified
    // domain), where the tenant admin controls the directory. `preferred_username`
    // is likewise mutable and never used as a link key.
    preflight: () => {
      if (MICROSOFT_SHARED_TENANTS.has((tenant || 'common').toLowerCase())) {
        throw new Error(OAUTH_MICROSOFT_TENANT_NOT_PINNED);
      }
    },
    toUserInfo: (d) => ({
      id: String(d.sub ?? d.oid),
      email: requireVerifiedEmail(d.email, true),
      name: optionalString(d.name),
      picture: optionalString(d.picture),
    }),
  });
}

// GitLab provider
//
// GitLab is standards-OIDC (also self-hostable). All endpoints derive from the
// configured base URL unless individually overridden. Userinfo supplies
// `email_verified`, which is required before linking.

function createGitLabProvider(): OAuthProvider {
  const { clientId, clientSecret, baseUrl, enabled } = config.oauth.gitlab;
  return createOidcStyleProvider({
    name: 'gitlab',
    enabled,
    clientId,
    clientSecret,
    authorizeUrl: config.oauth.gitlab.authorizeUrl || `${baseUrl}/oauth/authorize`,
    tokenUrl: config.oauth.gitlab.tokenUrl || `${baseUrl}/oauth/token`,
    userinfoUrl: config.oauth.gitlab.userinfoUrl || `${baseUrl}/oauth/userinfo`,
    toUserInfo: (d) => ({
      id: String(d.sub),
      email: requireVerifiedEmail(d.email, d.email_verified === true),
      name: optionalString(d.name),
      picture: optionalString(d.picture),
    }),
  });
}

// LinkedIn provider
//
// "Sign in with LinkedIn using OpenID Connect". LinkedIn only returns emails it
// has verified; it also emits `email_verified` (sometimes as the string
// "true"/"false"), which is honoured when present.

function createLinkedInProvider(): OAuthProvider {
  const { clientId, clientSecret, authorizeUrl, tokenUrl, userinfoUrl, enabled } = config.oauth.linkedin;
  return createOidcStyleProvider({
    name: 'linkedin',
    enabled,
    clientId,
    clientSecret,
    authorizeUrl,
    tokenUrl,
    userinfoUrl,
    toUserInfo: (d) => ({
      id: String(d.sub),
      email: requireVerifiedEmail(
        d.email,
        d.email_verified === undefined || d.email_verified === true || d.email_verified === 'true',
      ),
      name: optionalString(d.name),
      picture: optionalString(d.picture),
    }),
  });
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
  [OAUTH_UNSUPPORTED_PROVIDER]: { status: 400, message: 'Unsupported OAuth provider' },
  [OAUTH_PROVIDER_DISABLED]: { status: 400, message: 'OAuth provider is not configured' },
  [OAUTH_INVALID_STATE]: { status: 403, message: 'Invalid or expired OAuth state' },
  [OAUTH_TOKEN_EXCHANGE_FAILED]: { status: 502, message: 'Failed to exchange authorization code' },
  [OAUTH_USERINFO_FAILED]: { status: 502, message: 'Failed to fetch the account from the sign-in provider' },
  [OAUTH_NO_EMAIL]: { status: 400, message: 'The sign-in provider did not return an email address. Allow access to your email and try again.' },
  [OAUTH_EMAIL_UNVERIFIED]: { status: 403, message: 'The sign-in provider has not verified your email address. Verify it with the provider and try again.' },
  [OAUTH_MICROSOFT_TENANT_NOT_PINNED]: { status: 400, message: 'Microsoft sign-in is not available: the platform must be configured with a specific Microsoft tenant.' },
  [ACCOUNT_EMAIL_UNVERIFIED]: { status: 409, message: 'An account already exists for this email but is not verified. Verify (or reset the password on) that account first, then link this provider.' },
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
  if (!provider) throw new Error(OAUTH_UNSUPPORTED_PROVIDER);
  if (!provider.enabled) throw new Error(OAUTH_PROVIDER_DISABLED);

  // Consume-once: the store deletes the entry on lookup (valid or mismatched)
  // to prevent probing/replay.
  const pending = await pendingOAuthStates.consume(state);
  if (!pending || pending.provider !== providerName) throw new Error(OAUTH_INVALID_STATE);

  const accessToken = await provider.exchangeCode(code);
  return provider.fetchUserInfo(accessToken);
}

// Route handlers

export const getAuthUrl = withController('Get OAuth URL', async (req, res) => {
  const providerName = getParam(req.params, 'provider')!;
  const provider = getProvider(providerName);

  if (!provider) return sendError(res, 400, `Unsupported OAuth provider: ${providerName}`);
  if (!provider.enabled) return sendError(res, 400, `${providerName} OAuth is not configured`);

  const state = crypto.randomBytes(32).toString('hex');
  await pendingOAuthStates.put(state, { provider: providerName });

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

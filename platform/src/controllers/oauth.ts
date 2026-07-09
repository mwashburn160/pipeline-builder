// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { withController } from '../helpers/controller-helper.js';
import { authService } from '../services/index.js';
import { issueTokens } from '../utils/token.js';
import { validateBody, oauthCallbackSchema } from '../utils/validation.js';

const logger = createLogger('oauth-controller');

// OAuth State (CSRF protection)

/** Cap on in-memory OAuth state map. Each entry is ~80 bytes; default 1000
 *  caps memory at ~80 KB. Override via `OAUTH_MAX_PENDING_STATES`. */
const MAX_PENDING_STATES = parseInt(process.env.OAUTH_MAX_PENDING_STATES || '1000', 10);
// Bind each state to the provider that minted it so a state issued for one
// provider can't be replayed on another provider's callback.
const pendingOAuthStates = new Map<string, { provider: string; createdAt: number }>();

// `.unref()` so this background sweep doesn't keep Node alive in tests
// or worker scripts that import this module without starting the server.
setInterval(() => {
  const now = Date.now();
  for (const [key, { createdAt }] of pendingOAuthStates) {
    if (now - createdAt > config.oauth.stateTtlMs) pendingOAuthStates.delete(key);
  }
}, config.oauth.cleanupIntervalMs).unref();

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
      // Mirrors the GitHub path, which only ever returns a verified email.
      // (OIDC userinfo → `email_verified`; legacy oauth2/v2 → `verified_email`.)
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

      // GitHub may not return email in profile — fetch from /user/emails
      let email = profile.email as string | null;
      if (!email) {
        const emailsUrl = userinfoUrl.replace(/\/user$/, '/user/emails');
        const emailsRes = await fetch(emailsUrl, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        if (emailsRes.ok) {
          const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
          const primary = emails.find(e => e.primary && e.verified);
          email = primary?.email || emails.find(e => e.verified)?.email || null;
        }
      }
      if (!email) throw new Error('GitHub did not return a verified email address');

      return { id: String(profile.id), email, name: profile.name as string | undefined, picture: profile.avatar_url as string | undefined };
    },
  };
}

// Provider registry

type ProviderName = 'google' | 'github';

const providers: Record<ProviderName, OAuthProvider> = {
  google: createGoogleProvider(),
  github: createGitHubProvider(),
};

function getProvider(name: string): OAuthProvider | null {
  return providers[name as ProviderName] ?? null;
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

  const pending = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
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

  if (pendingOAuthStates.size >= MAX_PENDING_STATES) {
    // Evict oldest entries to make room
    const entriesToEvict = Math.max(1, Math.floor(MAX_PENDING_STATES * 0.1));
    const iterator = pendingOAuthStates.keys();
    for (let i = 0; i < entriesToEvict; i++) {
      const key = iterator.next().value;
      if (key) pendingOAuthStates.delete(key);
    }
  }

  const state = crypto.randomBytes(32).toString('hex');
  pendingOAuthStates.set(state, { provider: providerName, createdAt: Date.now() });

  sendSuccess(res, 200, { url: provider.buildAuthorizeUrl(state), state });
});

export const handleCallback = withController('OAuth callback', async (req, res) => {
  const providerName = getParam(req.params, 'provider')!;

  const body = validateBody(oauthCallbackSchema, req.body, res);
  if (!body) return;

  const userInfo = await verifyOAuthCode(providerName, body.code, body.state);

  const user = await authService.findOrCreateOAuthUser(providerName, userInfo);
  const tokens = await issueTokens(user, user.lastActiveOrgId?.toString());

  logger.info(`[OAUTH] ${providerName} login successful`, { userId: user._id, email: userInfo.email });
  sendSuccess(res, 200, tokens);
}, OAUTH_ERROR_MAP);

export const getProviders = withController('Get OAuth providers', async (_req, res) => {
  const enabled = Object.entries(providers).filter(([, p]) => p.enabled).map(([name]) => name);
  sendSuccess(res, 200, { providers: enabled });
});

import crypto from 'crypto';
import { createLogger, sendError, sendSuccess } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import { config } from '../config';
import { User } from '../models';
import { issueTokens } from '../utils/token';
import { validateBody, oauthCallbackSchema } from '../utils/validation';

const logger = createLogger('OAuthController');

// OAuth State (CSRF protection)

const pendingOAuthStates = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, createdAt] of pendingOAuthStates) {
    if (now - createdAt > config.oauth.stateTtlMs) pendingOAuthStates.delete(key);
  }
}, config.oauth.cleanupIntervalMs);

// Types

interface OAuthUserInfo {
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

// User resolution

async function findOrCreateUser(providerName: ProviderName, userInfo: OAuthUserInfo) {
  const byOAuth = await User.findOne({ [`oauth.${providerName}.id`]: userInfo.id }).select('+tokenVersion');
  if (byOAuth) return byOAuth;

  const byEmail = await User.findOne({ email: userInfo.email.toLowerCase() }).select('+tokenVersion');
  if (byEmail) {
    await User.updateOne({ _id: byEmail._id }, {
      $set: { [`oauth.${providerName}`]: { id: userInfo.id, email: userInfo.email, name: userInfo.name, picture: userInfo.picture, linkedAt: new Date() } },
    });
    return byEmail;
  }

  const baseUsername = (userInfo.name || userInfo.email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
  let username = baseUsername;
  let suffix = 1;
  while (await User.exists({ username })) { username = `${baseUsername}${suffix++}`; }

  const newUser = new User({
    username,
    email: userInfo.email.toLowerCase(),
    isEmailVerified: true,
    role: 'user',
    tokenVersion: 0,
    oauth: { [providerName]: { id: userInfo.id, email: userInfo.email, name: userInfo.name, picture: userInfo.picture, linkedAt: new Date() } },
  });
  await newUser.save();
  return newUser;
}

// Route handlers

export async function getAuthUrl(req: Request, res: Response): Promise<void> {
  const providerName = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
  const provider = getProvider(providerName);

  if (!provider) return sendError(res, 400, `Unsupported OAuth provider: ${providerName}`);
  if (!provider.enabled) return sendError(res, 400, `${providerName} OAuth is not configured`);

  const state = crypto.randomBytes(32).toString('hex');
  pendingOAuthStates.set(state, Date.now());

  sendSuccess(res, 200, { url: provider.buildAuthorizeUrl(state), state });
}

export async function handleCallback(req: Request, res: Response): Promise<void> {
  const providerName = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
  const provider = getProvider(providerName);

  if (!provider) return sendError(res, 400, `Unsupported OAuth provider: ${providerName}`);

  const body = validateBody(oauthCallbackSchema, req.body, res);
  if (!body) return;

  if (!pendingOAuthStates.has(body.state)) return sendError(res, 403, 'Invalid or expired OAuth state');
  pendingOAuthStates.delete(body.state);

  try {
    const accessToken = await provider.exchangeCode(body.code);
    const userInfo = await provider.fetchUserInfo(accessToken);

    if (!userInfo.email) return sendError(res, 400, `${providerName} did not return an email address`);

    const user = await findOrCreateUser(providerName as ProviderName, userInfo);
    const tokens = await issueTokens(user);

    logger.info(`[OAUTH] ${providerName} login successful`, { userId: user._id, email: userInfo.email });
    sendSuccess(res, 200, tokens);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'TOKEN_EXCHANGE_FAILED') return sendError(res, 502, `Failed to exchange authorization code with ${providerName}`);
    logger.error(`[OAUTH] ${providerName} callback error`, { error: message });
    return sendError(res, 500, 'OAuth authentication failed');
  }
}

export async function getProviders(_req: Request, res: Response): Promise<void> {
  const enabled = Object.entries(providers).filter(([, p]) => p.enabled).map(([name]) => name);
  sendSuccess(res, 200, { providers: enabled });
}

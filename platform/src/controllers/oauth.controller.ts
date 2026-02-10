/**
 * @module controllers/oauth
 * @description OAuth authentication controller (Google only).
 *
 * Implements server-side authorization code exchange for Google OAuth.
 *
 *   1. GET  /auth/oauth/google/url       → returns authorization URL
 *   2. POST /auth/oauth/google/callback   → exchanges code → issues JWT
 *   3. GET  /auth/oauth/providers         → returns enabled providers
 *
 * On callback the controller:
 *   - Exchanges the authorization code for a Google access token
 *   - Fetches the authenticated user's profile from Google
 *   - Finds or creates a local User (linking the Google OAuth provider)
 *   - Issues a platform JWT token pair (access + refresh)
 */

import crypto from 'crypto';
import { Request, Response } from 'express';
import { config } from '../config';
import { User } from '../models';
import { logger, sendError, issueTokens, validateBody, oauthCallbackSchema } from '../utils';

// ---------------------------------------------------------------------------
// OAuth State (CSRF protection)
// ---------------------------------------------------------------------------

/** In-memory store for OAuth state tokens. Each expires after the configured TTL. */
const pendingOAuthStates = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, createdAt] of pendingOAuthStates) {
    if (now - createdAt > config.oauth.stateTtlMs) pendingOAuthStates.delete(key);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OAuthUserInfo {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

// ---------------------------------------------------------------------------
// Google provider
// ---------------------------------------------------------------------------

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

function buildCallbackUrl(): string {
  return `${config.oauth.callbackBaseUrl}/auth/callback/google`;
}

/**
 * Exchange authorization code for Google access token.
 */
async function exchangeCode(code: string): Promise<string> {
  const { clientId, clientSecret } = config.oauth.google;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: buildCallbackUrl(),
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: params.toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok || !data.access_token) {
    logger.error('[OAUTH] Google token exchange failed', { status: res.status, error: data });
    throw new Error('TOKEN_EXCHANGE_FAILED');
  }

  return data.access_token as string;
}

/**
 * Fetch user info from Google.
 */
async function fetchGoogleUser(accessToken: string): Promise<OAuthUserInfo> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Failed to fetch Google user info');
  const data = await res.json() as Record<string, unknown>;
  return {
    id: data.id as string,
    email: data.email as string,
    name: data.name as string | undefined,
    picture: data.picture as string | undefined,
  };
}

/**
 * Find existing user by Google OAuth ID or email, or create a new one.
 * Links the Google provider to the user if not already linked.
 */
async function findOrCreateUser(userInfo: OAuthUserInfo) {
  // 1. Try to find by Google OAuth ID
  const byOAuth = await User.findOne({ 'oauth.google.id': userInfo.id })
    .select('+tokenVersion');

  if (byOAuth) return byOAuth;

  // 2. Try to find by email
  const byEmail = await User.findOne({ email: userInfo.email.toLowerCase() })
    .select('+tokenVersion');

  if (byEmail) {
    // Link Google provider to existing user
    await User.updateOne(
      { _id: byEmail._id },
      {
        $set: {
          'oauth.google': {
            id: userInfo.id,
            email: userInfo.email,
            name: userInfo.name,
            picture: userInfo.picture,
            linkedAt: new Date(),
          },
        },
      },
    );
    return byEmail;
  }

  // 3. Create new user
  const baseUsername = (userInfo.name || userInfo.email.split('@')[0])
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 30);

  // Ensure username uniqueness
  let username = baseUsername;
  let suffix = 1;
  while (await User.exists({ username })) {
    username = `${baseUsername}${suffix++}`;
  }

  const newUser = new User({
    username,
    email: userInfo.email.toLowerCase(),
    isEmailVerified: true, // Google emails are provider-verified
    role: 'user',
    tokenVersion: 0,
    oauth: {
      google: {
        id: userInfo.id,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        linkedAt: new Date(),
      },
    },
  });

  await newUser.save();
  return newUser;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /auth/oauth/google/url
 *
 * Returns the Google authorization URL the frontend should redirect to.
 */
export async function getAuthUrl(req: Request, res: Response): Promise<void> {
  const provider = req.params.provider;

  if (provider !== 'google') {
    return sendError(res, 400, `Unsupported OAuth provider: ${provider}`);
  }

  if (!config.oauth.google.enabled) {
    return sendError(res, 400, 'Google OAuth is not configured');
  }

  const state = crypto.randomBytes(32).toString('hex');
  pendingOAuthStates.set(state, Date.now());

  const params = new URLSearchParams({
    client_id: config.oauth.google.clientId,
    redirect_uri: buildCallbackUrl(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });

  const url = `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;

  res.json({ success: true, statusCode: 200, data: { url, state } });
}

/**
 * POST /auth/oauth/google/callback
 *
 * Exchanges authorization code for tokens, finds or creates the user,
 * and returns a platform JWT pair.
 *
 * Body: { code: string }
 */
export async function handleCallback(req: Request, res: Response): Promise<void> {
  const provider = req.params.provider;

  if (provider !== 'google') {
    return sendError(res, 400, `Unsupported OAuth provider: ${provider}`);
  }

  const body = validateBody(oauthCallbackSchema, req.body, res);
  if (!body) return;

  // Validate CSRF state parameter
  if (!pendingOAuthStates.has(body.state)) {
    return sendError(res, 403, 'Invalid or expired OAuth state');
  }
  pendingOAuthStates.delete(body.state);

  try {
    // Exchange code for Google access token
    const googleAccessToken = await exchangeCode(body.code);

    // Fetch user info from Google
    const userInfo = await fetchGoogleUser(googleAccessToken);

    if (!userInfo.email) {
      return sendError(res, 400, 'Google did not return an email address');
    }

    // Find or create local user
    const user = await findOrCreateUser(userInfo);

    // Issue platform JWT tokens
    const tokens = await issueTokens(user);

    logger.info('[OAUTH] Google login successful', {
      userId: user._id,
      email: userInfo.email,
    });

    res.json({ success: true, statusCode: 200, data: tokens });
  } catch (err: unknown) {
    const errorMap: Record<string, { status: number; message: string }> = {
      TOKEN_EXCHANGE_FAILED: { status: 502, message: 'Failed to exchange authorization code with Google' },
    };

    const message = err instanceof Error ? err.message : String(err);
    const mapped = errorMap[message];
    if (mapped) {
      return sendError(res, mapped.status, mapped.message);
    }

    logger.error('[OAUTH] Google callback error', { error: message });
    return sendError(res, 500, 'OAuth authentication failed');
  }
}

/**
 * GET /auth/oauth/providers
 *
 * Returns which OAuth providers are enabled.
 */
export async function getProviders(_req: Request, res: Response): Promise<void> {
  const providers: string[] = [];
  if (config.oauth.google.enabled) providers.push('google');

  res.json({ success: true, statusCode: 200, data: { providers } });
}

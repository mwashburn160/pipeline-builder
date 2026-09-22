// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import { bindLoginToBrowser, clearLoginBinding } from '../helpers/login-binding.js';
import { completeInteractiveSignIn, sendMfaChallenge } from '../helpers/sign-in.js';
import { rejectIfSsoEnforced } from '../helpers/sso-enforcement.js';
import { incCounter } from '../observability/metrics.js';
import { OAUTH_PASSKEY_REQUIRED } from '../services/auth-errors.js';
import { authService } from '../services/index.js';
import { enabledOAuthProviders, OAUTH_ERROR_MAP, startOAuthSignIn, verifyOAuthCode } from '../services/oauth-providers.js';
import { signInAuth } from '../services/session/access-tokens.js';
import { validateBody, oauthCallbackSchema } from '../utils/validation.js';

const logger = createLogger('oauth-controller');

// Route handlers

export const getAuthUrl = withController('Get OAuth URL', async (req, res) => {
  const started = await startOAuthSignIn(getParam(req.params, 'provider')!, () => bindLoginToBrowser(res));
  if ('error' in started) return sendError(res, 400, started.error);
  sendSuccess(res, 200, started);
});

/** Which second factor (if any) an account's sign-in owes. */
async function secondFactorFor(userId: string): Promise<'totp' | 'passkey' | null> {
  const { loadSignInMethods } = await import('../helpers/sign-in-methods.js');
  const methods = await loadSignInMethods(userId);
  if (methods.hasTotp) return 'totp';
  return methods.passkeyCount > 0 ? 'passkey' : null;
}

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
    userInfo = await verifyOAuthCode(providerName, body.code, body.state, req);
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

  // SECOND FACTOR: a social sign-in is a FIRST factor exactly like a password,
  // so an account with a factor enrolled owes it here too — otherwise the
  // provider would be a way around the factor the person set up. An
  // authenticator app → the same MFA challenge password login answers (the
  // session opens at `aal: 2` once the code verifies); a passkey alone has no
  // code to ask for on this leg, so the person signs in with the passkey.
  const second = await secondFactorFor(user._id.toString());
  if (second === 'totp') {
    clearLoginBinding(res);
    return sendMfaChallenge(res, user._id.toString(), user.lastActiveOrgId?.toString(), { firstFactor: 'oauth' });
  }
  if (second === 'passkey') throw new Error(OAUTH_PASSKEY_REQUIRED);

  // Social sign-in opens an INTERACTIVE session (`amr: ['oauth']`), established
  // exactly like password login, cookie transport included.
  await completeInteractiveSignIn(req, res, user, {
    orgId: user.lastActiveOrgId?.toString(),
    auth: signInAuth('oauth'),
    clearBinding: true,
  });
  logger.info(`[OAUTH] ${providerName} login successful`, { userId: user._id, email: userInfo.email });
}, OAUTH_ERROR_MAP);

export const getProviders = withController('Get OAuth providers', async (_req, res) => {
  sendSuccess(res, 200, { providers: enabledOAuthProviders() });
});

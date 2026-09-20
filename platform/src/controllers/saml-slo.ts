// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML 2.0 Single Logout (SLO).
 *
 *   POST     /auth/sso/logout              → { redirectUrl | null }   (SP-initiated)
 *   GET|POST /auth/sso/:orgId/saml/slo     → 302                      (IdP → us)
 *
 * SP-INITIATED — the browser app calls `POST /auth/sso/logout` right before its
 * ordinary `POST /auth/logout`. When the session being ended was opened by a
 * SAML sign-in AND the org's IdP has a Single Logout URL, the answer is a signed
 * LogoutRequest redirect naming the IdP's own `NameID` + `SessionIndex` for that
 * sign-in; the app follows it after the local sign-out, so the person is signed
 * out of the IdP too. Otherwise `redirectUrl` is null and sign-out stays local.
 * The IdP then answers at the SLO endpoint with a LogoutResponse, which is
 * verified (signature, issuer, InResponseTo naming our request) and the browser
 * lands back on the sign-in page.
 *
 * IDP-INITIATED — the IdP sends a signed LogoutRequest to the SLO endpoint (the
 * HTTP-Redirect or HTTP-POST binding). Once it verifies — signature REQUIRED on
 * both bindings, issuer pinned to the org's IdP, validity window, one use per
 * request id — every platform session that SAML sign-ins of that `NameID`
 * (narrowed to the `SessionIndex` when the IdP names one) opened IN THIS ORG is
 * revoked, through the same helper that "sign out this device" uses
 * (`authService.revokeRefreshSession`): the refresh slot is removed at once, so
 * nothing can renew, and the short-lived access token lapses within its TTL. The
 * IdP gets a signed LogoutResponse at its SLO URL (or, with none configured, the
 * browser lands on the sign-in page).
 */

import { createLogger, getParam, sendSuccess, errorMessage } from '@pipeline-builder/api-core';
import type { Request } from 'express';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import { getSamlConfigForLogout } from '../helpers/sso-enforcement.js';
import SamlSession from '../models/saml-session.js';
import { incCounter } from '../observability/metrics.js';
import { authService } from '../services/index.js';
import {
  SAML_ERROR_MAP,
  type SamlLogoutBinding,
  type SamlSessionRef,
  buildSamlLogoutRequestUrl,
  buildSamlLogoutResponseUrl,
  samlLandingUrl,
  validateSamlLogoutMessage,
} from '../services/saml-service.js';

const logger = createLogger('saml-slo');

/** The `sid` claim of an access token this deployment just minted. */
function sessionIdOf(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sid?: unknown };
    return typeof payload.sid === 'string' ? payload.sid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record the IdP's handle on a SAML sign-in against the session slot it opened.
 * Best-effort: a failure here costs only the ability to single-log-out that one
 * session, so it is logged, never allowed to fail the sign-in.
 */
export async function recordSamlSession(input: {
  userId: string;
  orgId: string;
  accessToken: string;
  issuer: string;
  session: SamlSessionRef;
}): Promise<void> {
  const sessionId = sessionIdOf(input.accessToken);
  if (!sessionId) return;
  try {
    await SamlSession.updateOne(
      { userId: input.userId, sessionId },
      {
        $set: {
          orgId: input.orgId,
          issuer: input.issuer,
          nameID: input.session.nameID,
          nameIDFormat: input.session.nameIDFormat,
          sessionIndex: input.session.sessionIndex,
          expiresAt: new Date(Date.now() + config.auth.refreshToken.expiresIn * 1000),
        },
      },
      { upsert: true },
    );
  } catch (err) {
    logger.warn('Could not record the SAML session for single logout', {
      orgId: input.orgId, error: errorMessage(err),
    });
  }
}

/**
 * POST /auth/sso/logout — the SP-initiated LogoutRequest for the CALLER'S OWN
 * current session, or `{ redirectUrl: null }` when it wasn't a SAML session or
 * the IdP has no SLO URL. Forgets the session's SAML record either way; the
 * caller ends the platform session itself with `POST /auth/logout`.
 */
export const startSsoLogout = withController('Start SSO logout', async (req, res) => {
  const userId = req.user?.sub ? String(req.user.sub) : undefined;
  const sessionId = (req.user as { sid?: string } | undefined)?.sid;
  if (!userId || !sessionId) {
    sendSuccess(res, 200, { redirectUrl: null });
    return;
  }

  const row = await SamlSession.findOneAndDelete({ userId, sessionId }).lean();
  if (!row) {
    sendSuccess(res, 200, { redirectUrl: null });
    return;
  }

  let redirectUrl: string | null = null;
  try {
    const cfg = await getSamlConfigForLogout(row.orgId);
    // Only the IdP that issued the session can end it; a connection that has
    // since been repointed at another IdP gets no LogoutRequest.
    if (cfg.sloUrl && cfg.entityId === row.issuer) {
      redirectUrl = await buildSamlLogoutRequestUrl(cfg, row, '');
    }
  } catch (err) {
    logger.warn('SP-initiated SAML logout unavailable', { orgId: row.orgId, error: errorMessage(err) });
  }

  if (redirectUrl) {
    audit(req, 'sso.saml.logout', {
      targetType: 'user',
      targetId: userId,
      affectedOrgId: row.orgId,
      details: { direction: 'sp', stage: 'request' },
    });
    incCounter('platform_saml_slo_total', { direction: 'sp', result: 'request' });
  }
  sendSuccess(res, 200, { redirectUrl });
}, SAML_ERROR_MAP);

/**
 * How many SAML session rows one SLO request revokes per round trip, and the
 * hard ceiling on the whole request.
 *
 * The endpoint is UNAUTHENTICATED (signature-gated only) and IdP-driven, and a
 * LogoutRequest naming only a `NameID` matches EVERY session that person has in
 * the org. The old code read the whole match set with an unbounded `find()` and
 * then revoked serially, so one message could pull an arbitrary number of rows
 * into memory and hold a request open for as many sequential writes — a cheap
 * amplification lever for anyone who can get one signed logout replayed.
 *
 * So: bounded batches, each revoked in parallel, repeated until the filter is
 * drained or {@link SLO_MAX_SESSIONS_PER_REQUEST} rows have been handled. The
 * cap is not a correctness loss — every unrevoked row is a refresh slot that
 * still expires on its own TTL, and the person's next SLO (or sign-out) clears
 * the rest — but it IS reported, in the audit detail and as its own metric
 * label, so a tenant legitimately over the cap is visible rather than silent.
 */
const SLO_REVOKE_BATCH_SIZE = 100;
const SLO_MAX_SESSIONS_PER_REQUEST = 1000;

/**
 * Revoke the platform sessions matching an IdP LogoutRequest, in bounded
 * batches. Each row's refresh slot is removed (so nothing can renew) and the
 * bookkeeping row deleted; `drained` is false when the cap stopped us early.
 */
async function revokeMatchingSamlSessions(
  filter: Record<string, unknown>,
): Promise<{ revoked: number; userIds: string[]; drained: boolean }> {
  const seenUsers = new Set<string>();
  let revoked = 0;
  for (;;) {
    const remaining = SLO_MAX_SESSIONS_PER_REQUEST - revoked;
    if (remaining <= 0) return { revoked, userIds: [...seenUsers], drained: false };
    const rows = await SamlSession.find(filter)
      .select('_id userId sessionId')
      .limit(Math.min(SLO_REVOKE_BATCH_SIZE, remaining))
      .lean();
    if (rows.length === 0) return { revoked, userIds: [...seenUsers], drained: true };

    await Promise.all(rows.map((row) => authService.revokeRefreshSession(row.userId, row.sessionId)));
    // Delete AFTER the revokes so a mid-batch failure leaves the rows in place
    // for the next attempt rather than losing the handle on a live session.
    await SamlSession.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    for (const row of rows) seenUsers.add(row.userId);
    revoked += rows.length;
  }
}

/** The SLO message as it arrived, on whichever binding. */
function bindingOf(req: Request): { message: SamlLogoutBinding; relayState?: string } {
  const pick = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  if (req.method === 'GET') {
    const query: Record<string, string> = {};
    for (const key of ['SAMLRequest', 'SAMLResponse', 'RelayState', 'SigAlg', 'Signature']) {
      const v = pick((req.query as Record<string, unknown>)[key]);
      if (v !== undefined) query[key] = v;
    }
    const q = req.originalUrl.indexOf('?');
    return {
      message: { binding: 'redirect', query, rawQuery: q >= 0 ? req.originalUrl.slice(q + 1) : '' },
      relayState: query.RelayState,
    };
  }
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const body: Record<string, string> = {};
  for (const key of ['SAMLRequest', 'SAMLResponse', 'RelayState']) {
    const v = pick(raw[key]);
    if (v !== undefined) body[key] = v;
  }
  return { message: { binding: 'post', body }, relayState: body.RelayState };
}

/**
 * GET|POST /auth/sso/:orgId/saml/slo — the SP's Single Logout endpoint.
 * Unauthenticated by construction (the IdP drives it through the browser); every
 * outcome is a redirect.
 */
export const handleSamlSlo = withController('SAML SLO', async (req, res) => {
  const orgId = getParam(req.params, 'orgId')!;
  const { message, relayState } = bindingOf(req);

  let cfg;
  let verified;
  try {
    cfg = await getSamlConfigForLogout(orgId);
    verified = await validateSamlLogoutMessage(cfg, message);
  } catch (err) {
    const code = err instanceof Error ? err.message : 'error';
    audit(req, 'sso.saml.logout', {
      targetType: 'user',
      outcome: 'failure',
      affectedOrgId: orgId,
      details: { direction: 'unknown', reason: code === 'SAML_INVALID_LOGOUT' ? 'invalid_message' : 'not_configured' },
    });
    incCounter('platform_saml_slo_total', { direction: 'unknown', result: 'refused' });
    res.redirect(302, `${samlLandingUrl(orgId)}?error=SAML_INVALID_LOGOUT`);
    return;
  }

  if (verified.kind === 'response') {
    audit(req, 'sso.saml.logout', {
      targetType: 'user',
      affectedOrgId: orgId,
      details: { direction: 'sp', stage: 'complete' },
    });
    incCounter('platform_saml_slo_total', { direction: 'sp', result: 'complete' });
    res.redirect(302, `${config.oauth.callbackBaseUrl}/`);
    return;
  }

  // IdP-initiated: revoke every session of that NameID (and SessionIndex, when
  // named) that this IdP's sign-ins opened in THIS org.
  const filter = {
    orgId,
    issuer: cfg.entityId,
    nameID: verified.session.nameID,
    ...(verified.session.sessionIndex ? { sessionIndex: verified.session.sessionIndex } : {}),
  };
  const { revoked, userIds, drained } = await revokeMatchingSamlSessions(filter);

  audit(req, 'sso.saml.logout', {
    targetType: 'user',
    ...(userIds.length === 1 ? { targetId: userIds[0] } : {}),
    affectedOrgId: orgId,
    details: { direction: 'idp', sessionsRevoked: revoked, userIds, ...(drained ? {} : { capped: SLO_MAX_SESSIONS_PER_REQUEST }) },
  });
  incCounter('platform_saml_slo_total', { direction: 'idp', result: revoked > 0 ? 'revoked' : 'no_session' });
  if (!drained) {
    incCounter('platform_saml_slo_total', { direction: 'idp', result: 'capped' });
    logger.warn('[SAML] IdP-initiated logout hit its per-request cap — remaining sessions lapse with their refresh window', {
      orgId, revoked, cap: SLO_MAX_SESSIONS_PER_REQUEST,
    });
  }
  logger.info('[SAML] IdP-initiated logout', { orgId, sessionsRevoked: revoked });

  if (cfg.sloUrl) {
    // Success even when no session matched: the person is not signed in here,
    // which is exactly the state the IdP asked for.
    res.redirect(302, await buildSamlLogoutResponseUrl(cfg, verified.id, true, relayState));
    return;
  }
  res.redirect(302, `${config.oauth.callbackBaseUrl}/`);
}, SAML_ERROR_MAP);

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Device authorization grant endpoints (RFC 8628).
 *
 * Two audiences, two response shapes — deliberately:
 *
 *  - The PROTOCOL endpoints (`/auth/device/code`, `/auth/device/token`) are
 *    spoken by an OAuth client (the CLI), so they use the RFC's own JSON:
 *    snake_case fields, and errors as `{ error, error_description }` with the
 *    RFC's codes (`authorization_pending`, `slow_down`, `expired_token`,
 *    `access_denied`). They do NOT use the platform's `{ success, data }`
 *    envelope, because a standards client must not have to learn it.
 *  - The BROWSER endpoints (`/auth/device/authorize|approve|deny`) are ordinary
 *    platform API calls from the approval page and use the normal envelope.
 *
 * Approval is step-up gated (route middleware). That is the point of routing
 * sign-in through the browser: whatever the account can prove — password today,
 * provider re-auth for social/SSO accounts, passkeys and TOTP later — is what
 * gates handing a shell a session, and none of it ever reaches the CLI.
 */

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { clientInfoOf } from '../helpers/client-info.js';
import { ensureAuthenticated, withController } from '../helpers/controller-helper.js';
import { incCounter } from '../observability/metrics.js';
import {
  decide,
  findByUserCode,
  formatUserCode,
  poll,
  startDeviceAuthorization,
  type DeviceAuthRecord,
} from '../services/device-auth-service.js';
import { authService } from '../services/index.js';
import { authFromClaims, issueStepUpToken } from '../services/session/access-tokens.js';
import { findRefreshSession, issueTokens } from '../services/session/refresh-sessions.js';
import type { AccessTokenPayload } from '../types/index.js';

const logger = createLogger('device-auth-controller');

/** Where the browser approves a code. */
function verificationUri(): string {
  return `${config.app.frontendUrl}/auth/device`;
}

/** RFC 8628 error response — 400 for every protocol error, per §3.5. */
function rfcError(res: Response, error: string, description: string, extra: Record<string, unknown> = {}): void {
  res.status(400).json({ error, error_description: description, ...extra });
}

/**
 * POST /auth/device/code — start a device authorization.
 *
 * Pre-auth by construction: the caller has no identity yet, which is what the
 * flow is for. The only client-controlled input is `step_up`, a request for a
 * step-up token alongside the session (`auth pat` needs one to create a key);
 * it can only ever make the approval MORE demanding, never less.
 */
export const startDeviceCode = withController('Device authorization start', async (req, res) => {
  const client = clientInfoOf(req);
  const stepUpRequested = req.body?.step_up === true;
  const started = await startDeviceAuthorization({ client, stepUpRequested });

  audit(req, 'device.authorize.start', {
    targetType: 'device-authorization',
    targetId: started.id,
    details: { client: client.userAgent, stepUp: stepUpRequested },
  });
  incCounter('platform_device_authorizations_total', { result: 'start' });

  const userCode = formatUserCode(started.userCode);
  res.status(200).json({
    device_code: started.deviceCode,
    user_code: userCode,
    verification_uri: verificationUri(),
    verification_uri_complete: `${verificationUri()}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: Math.max(1, Math.round((started.expiresAt - Date.now()) / 1000)),
    interval: started.intervalSeconds,
  });
});

/**
 * POST /auth/device/token — the CLI's poll.
 *
 * Returns the RFC's pending/backoff/terminal errors until the browser decides,
 * then ONE token response for the approved code (the flow is consumed on the
 * poll that wins). The session opened here is an ordinary `interactive` refresh
 * session carrying the requesting device's details, so it appears — and can be
 * signed out — on the sessions-and-devices page like any other device.
 */
export const deviceToken = withController('Device authorization token', async (req, res) => {
  const result = await poll(req.body?.device_code);

  if (result.outcome === 'authorization_pending') {
    rfcError(res, 'authorization_pending', 'The user has not yet approved this device.');
    return;
  }
  if (result.outcome === 'slow_down') {
    incCounter('platform_device_authorizations_total', { result: 'slow_down' });
    rfcError(res, 'slow_down', 'Polling too frequently — wait for the interval before retrying.', { interval: result.interval });
    return;
  }
  if (result.outcome === 'access_denied') {
    incCounter('platform_device_authorizations_total', { result: 'denied_poll' });
    rfcError(res, 'access_denied', 'The request was denied.');
    return;
  }
  if (result.outcome === 'expired_token') {
    // One answer for an unknown code, a lapsed one, one that blew the poll
    // ceiling and one already redeemed — indistinguishable to a legitimate
    // client, and collapsing them denies an enumeration oracle. Only a flow that
    // REALLY existed is audited/counted, so repeating a guessed code can't flood
    // the audit log.
    if (result.existed) {
      audit(req, 'device.authorize.expire', { targetType: 'device-authorization' });
      incCounter('platform_device_authorizations_total', { result: 'expired' });
    }
    rfcError(res, 'expired_token', 'The device code has expired or is no longer valid.');
    return;
  }

  const { record, approval } = result;
  const user = await authService.findForTokenIssue(approval.userId);
  // Fail closed, and don't say why, when the approval no longer speaks for a
  // live session: the account is gone, its sessions were revoked since
  // (tokenVersion moved), or the approving browser session was signed out.
  const approverSlotGone = !!approval.sessionId && !!user && !(await findRefreshSession(user._id, approval.sessionId));
  if (!user || user.tokenVersion !== approval.tokenVersion || approverSlotGone) {
    logger.warn('Device authorization approval no longer valid at issue', { deviceRequestId: record.id, userGone: !user });
    incCounter('platform_device_authorizations_total', { result: 'issue_failed' });
    rfcError(res, 'access_denied', 'The request was denied.');
    return;
  }

  const tokens = await issueTokens(user, approval.orgId, {
    kind: 'interactive',
    // The CLI session INHERITS the approving browser session's assurance and
    // sign-in time — approving on a device can never raise either.
    auth: { amr: approval.amr, aal: approval.aal, authTime: new Date(approval.authTime) },
    client: record.client,
  });

  // A step-up token only when the CLI asked for one at start AND the approval's
  // own step-up is still fresh — `auth pat` uses it immediately to create a key.
  // Minted as `reauth` because it was earned by a re-verification in the browser
  // (which factor that was is recorded on the approve audit event).
  const stepUpFresh = Date.now() - approval.stepUpVerifiedAt <= config.auth.device.approvalGraceMs;
  const stepUp = record.stepUpRequested && stepUpFresh ? await issueStepUpToken(approval.userId, 'reauth') : undefined;

  incCounter('platform_device_authorizations_total', { result: 'issued' });
  res.status(200).json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    ...(stepUp ? { step_up_token: stepUp.token, step_up_expires_at: stepUp.expiresAt } : {}),
  });
});

/** The approval page's view of a pending request — never the device code. */
function requestView(record: DeviceAuthRecord) {
  return {
    userCode: formatUserCode(record.userCode),
    client: record.client.userAgent ?? null,
    ip: record.client.ip ?? null,
    requestedAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    stepUpRequested: record.stepUpRequested,
  };
}

/** Turn a lookup/decision miss into the caller-facing response. */
function decisionError(res: Response, outcome: 'not_found' | 'expired' | 'already_decided'): void {
  if (outcome === 'expired') {
    sendError(res, 410, 'That code has expired. Start the sign-in again on your device.');
    return;
  }
  if (outcome === 'already_decided') {
    sendError(res, 409, 'That code has already been used.');
    return;
  }
  sendError(res, 404, 'That code was not recognised. Check it and try again.');
}

/**
 * GET /auth/device/authorize?user_code=… — what the signed-in user is being
 * asked to approve. Authenticated and rate-limited per user, which is what
 * bounds guessing the short user code.
 */
export const getDeviceRequest = withController('Device authorization lookup', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const located = await findByUserCode(req.query.user_code);
  if (located === 'expired') {
    audit(req, 'device.authorize.expire', { targetType: 'device-authorization' });
    incCounter('platform_device_authorizations_total', { result: 'expired' });
    decisionError(res, 'expired');
    return;
  }
  if (!located) {
    decisionError(res, 'not_found');
    return;
  }
  if (located.record.status !== 'pending') {
    decisionError(res, 'already_decided');
    return;
  }
  sendSuccess(res, 200, { request: requestView(located.record) });
});

/**
 * POST /auth/device/approve — grant the waiting device a session.
 *
 * Step-up gated by the route, so the person at the browser has just re-proved
 * who they are. The approving session's org and assurance are what the CLI
 * session gets; nothing is minted until the device's next poll.
 */
export const approveDeviceRequest = withController('Device authorization approve', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const located = await findByUserCode(req.body?.userCode);
  if (located === 'expired' || !located) {
    decisionError(res, located === 'expired' ? 'expired' : 'not_found');
    return;
  }

  // Inherited verbatim from the approving browser session — never re-derived
  // from the request, so an approval can't raise assurance or reset sign-in time.
  const session = authFromClaims(req.user as AccessTokenPayload);
  // The approver's HARD tokenVersion now, re-checked at issue: revoking the
  // approver's sessions in between voids the approval.
  const approver = await authService.findForTokenIssue(req.user.sub);
  if (!approver) {
    sendError(res, 401, 'Session invalid');
    return;
  }
  const approverSid = (req.user as AccessTokenPayload).sid;
  const outcome = await decide(located.record.userCode, 'approved', {
    userId: req.user.sub,
    ...(req.user.organizationId ? { orgId: req.user.organizationId } : {}),
    amr: session.amr,
    aal: session.aal,
    authTime: session.authTime.getTime(),
    stepUpVerifiedAt: Date.now(),
    tokenVersion: approver.tokenVersion,
    ...(approverSid ? { sessionId: approverSid } : {}),
  });
  if (outcome !== 'ok') {
    decisionError(res, outcome);
    return;
  }

  audit(req, 'device.authorize.approve', {
    targetType: 'device-authorization',
    targetId: located.record.id,
    details: { client: located.record.client.userAgent, stepUp: located.record.stepUpRequested },
  });
  incCounter('platform_device_authorizations_total', { result: 'approved' });
  sendSuccess(res, 200, { approved: true, request: requestView(located.record) });
});

/** POST /auth/device/deny — refuse the waiting device. The next poll gets
 *  `access_denied` and the flow is discarded. */
export const denyDeviceRequest = withController('Device authorization deny', async (req, res) => {
  if (!ensureAuthenticated(req, res)) return;
  const located = await findByUserCode(req.body?.userCode);
  if (located === 'expired' || !located) {
    decisionError(res, located === 'expired' ? 'expired' : 'not_found');
    return;
  }

  const outcome = await decide(located.record.userCode, 'denied');
  if (outcome !== 'ok') {
    decisionError(res, outcome);
    return;
  }

  audit(req, 'device.authorize.deny', {
    targetType: 'device-authorization',
    targetId: located.record.id,
    details: { client: located.record.client.userAgent },
  });
  incCounter('platform_device_authorizations_total', { result: 'denied' });
  sendSuccess(res, 200, { denied: true });
});

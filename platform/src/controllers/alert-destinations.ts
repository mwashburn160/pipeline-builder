// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for per-org alert notification destinations + the Alertmanager
 * webhook relay endpoint.
 *
 *   GET    /api/observability/alert-destinations      — list this org's destinations
 *   POST   /api/observability/alert-destinations      — create
 *   PUT    /api/observability/alert-destinations/:id  — update
 *   DELETE /api/observability/alert-destinations/:id  — delete
 *   POST   /api/observability/alert-webhook           — relay endpoint (called by Alertmanager)
 *
 * The relay is the only path with a non-JWT auth gate: it's called server-to-
 * server from Alertmanager, which lives on the same network as platform.
 * We gate on a shared `ALERT_WEBHOOK_TOKEN` env var instead of a user JWT.
 * The other endpoints all require `requireAuth` and at least org-admin to
 * create/update/delete (org admins own their notification surface).
 */

import { createLogger, sendError, sendQuotaExceeded, sendSuccess } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { isSystemAdmin, requireAuthContext, requireOrgMembership, withController } from '../helpers/controller-helper.js';
import { releaseFeatureQuota, reserveFeatureQuota } from '../middleware/quota.js';
import { alertDestinationService, DestinationNotFoundError, toApiDestination } from '../services/alert-destination-service.js';
import { relayWebhook, type AlertmanagerWebhook } from '../services/alert-relay.js';
import { isReasonableString } from '../utils/string-guards.js';

const logger = createLogger('alert-destinations-controller');

/** UI-displayed label length. Override via `ALERT_DESTINATION_MAX_LABEL`. */
const MAX_LABEL = parseInt(process.env.ALERT_DESTINATION_MAX_LABEL || '100', 10);
/** Slack/webhook URL length cap. Slack hooks are ~85 chars but enterprise
 *  webhooks signed with long query params can be much longer — 2048 is
 *  HTTP-spec-safe. Override via `ALERT_DESTINATION_MAX_TARGET`. */
const MAX_TARGET = parseInt(process.env.ALERT_DESTINATION_MAX_TARGET || '2048', 10);


/** Single-address email check — intentionally loose (no RFC 5322 parsing);
 *  catches typos, not every invalid address. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate channel/target combos. Slack URLs must start with the canonical
 *  hooks.slack.com host so a misconfigured destination doesn't silently POST
 *  to an arbitrary URL. Webhook channel takes any HTTPS URL. Email takes a
 *  single address. */
function validateChannelTarget(channel: string, target: string): string | null {
  if (channel === 'slack') {
    if (!/^https:\/\/hooks\.slack\.com\//.test(target)) {
      return 'Slack target must be a hooks.slack.com URL';
    }
    if (target.length > MAX_TARGET) return `Slack URL exceeds ${MAX_TARGET} chars`;
    return null;
  }
  if (channel === 'webhook') {
    if (!/^https:\/\//.test(target)) return 'Webhook target must be an HTTPS URL';
    if (target.length > MAX_TARGET) return `Webhook URL exceeds ${MAX_TARGET} chars`;
    return null;
  }
  if (channel === 'email') {
    if (!EMAIL_RE.test(target)) return 'Email target must be a valid email address';
    if (target.length > MAX_TARGET) return `Email address exceeds ${MAX_TARGET} chars`;
    return null;
  }
  if (channel === 'in-app') {
    return null;
  }
  return 'channel must be slack, webhook, in-app, or email';
}

/** Accepted destination channels. `in-app` needs no target; the rest do. */
function isValidChannel(c: unknown): c is 'slack' | 'webhook' | 'in-app' | 'email' {
  return c === 'slack' || c === 'webhook' || c === 'in-app' || c === 'email';
}

/** GET /api/observability/alert-destinations — list this org's destinations. */
export const listAlertDestinations = withController('List alert destinations', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const destinations = await alertDestinationService.listForOrg(orgId);
  // Mask the target field on read — Slack URLs are bearer-equivalent.
  sendSuccess(res, 200, { destinations: destinations.map(toApiDestination) });
});

/**
 * GET /api/observability/alert-destinations/all — sysadmin cross-tenant
 * list. Same masked-target shape as the per-org list, but grouped by
 * orgId on the client. Wrapped in a privileged tenant context so RLS
 * lets the query span tenants.
 */
export const listAllAlertDestinations = withController('List all alert destinations', async (req, res) => {
  if (!isSystemAdmin(req)) return sendError(res, 403, 'System admin required');

  const destinations = await runWithTenantContext({ isSuperAdmin: true }, () =>
    alertDestinationService.listAllAcrossOrgs(),
  );
  sendSuccess(res, 200, { destinations: destinations.map(toApiDestination) });
});

/** POST /api/observability/alert-destinations — create. Org-admin or above. */
export const createAlertDestination = withController('Create alert destination', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  // Static `observability:write` gate now enforced at the route
  // (`requirePermission('observability:write')`), auditable in the route table.

  const body = req.body as { channel?: unknown; target?: unknown; label?: unknown; minSeverity?: unknown; enabled?: unknown };

  if (!isValidChannel(body.channel)) {
    return sendError(res, 400, 'channel must be slack, webhook, in-app, or email');
  }
  if (!isReasonableString(body.label, MAX_LABEL)) {
    return sendError(res, 400, `label is required (max ${MAX_LABEL} chars)`);
  }
  const target = typeof body.target === 'string' ? body.target : '';
  if (body.channel !== 'in-app') {
    const err = validateChannelTarget(body.channel, target);
    if (err) return sendError(res, 400, err);
  }
  if (body.minSeverity !== undefined && body.minSeverity !== 'warning' && body.minSeverity !== 'critical') {
    return sendError(res, 400, 'minSeverity must be warning or critical');
  }

  // Per-org cap on alert destinations. Reserve atomically before insert so
  // two concurrent creates at the limit can't both succeed.
  const reservation = await reserveFeatureQuota(orgId, 'alertDestinations');
  if (reservation.exceeded) {
    return sendQuotaExceeded(res, 'alertDestinations', reservation.quota, reservation.quota.resetAt);
  }

  try {
    const created = await alertDestinationService.create(
      {
        channel: body.channel,
        target,
        label: body.label,
        minSeverity: (body.minSeverity as 'warning' | 'critical' | undefined),
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      },
      { orgId, userId },
    );

    audit(req, 'alert.destination.create', {
      targetType: 'alert-destination',
      targetId: created.id,
      details: { channel: created.channel, label: created.label, minSeverity: created.minSeverity },
    });
    sendSuccess(res, 201, { destination: toApiDestination(created) });
  } catch (err) {
    // Roll back the reserved slot on any failure — keeps the counter accurate
    // when the DB write fails after the quota service already committed.
    releaseFeatureQuota(orgId, 'alertDestinations', logger.warn.bind(logger));
    throw err;
  }
});

/** PUT /api/observability/alert-destinations/:id — update. */
export const updateAlertDestination = withController('Update alert destination', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  // Static `observability:write` gate now enforced at the route.

  const id = req.params.id as string;
  const body = req.body as { channel?: unknown; target?: unknown; label?: unknown; minSeverity?: unknown; enabled?: unknown };

  if (body.channel !== undefined && !isValidChannel(body.channel)) {
    return sendError(res, 400, 'channel must be slack, webhook, in-app, or email');
  }
  if (body.label !== undefined && !isReasonableString(body.label, MAX_LABEL)) {
    return sendError(res, 400, `label must be <= ${MAX_LABEL} chars`);
  }
  if (body.target !== undefined && body.target !== '') {
    if (typeof body.target !== 'string') return sendError(res, 400, 'target must be a string');
    // Validate against the new channel if supplied, otherwise look up the existing channel.
    let channel: string;
    if (typeof body.channel === 'string') {
      channel = body.channel;
    } else {
      const existing = await alertDestinationService.findById(id, orgId);
      if (!existing) return sendError(res, 404, 'Destination not found');
      channel = existing.channel;
    }
    const err = validateChannelTarget(channel, body.target);
    if (err) return sendError(res, 400, err);
  } else if (typeof body.channel === 'string') {
    // Channel changed but no new target supplied — re-validate the STORED target
    // against the new channel's rules, else a webhook target (e.g. an internal
    // URL) could be relabeled as slack/email and bypass the channel allowlist.
    const existing = await alertDestinationService.findById(id, orgId);
    if (!existing) return sendError(res, 404, 'Destination not found');
    const err = validateChannelTarget(body.channel, existing.target);
    if (err) return sendError(res, 400, err);
  }
  if (body.minSeverity !== undefined && body.minSeverity !== 'warning' && body.minSeverity !== 'critical') {
    return sendError(res, 400, 'minSeverity must be warning or critical');
  }

  const updated = await alertDestinationService.update(
    id,
    {
      channel: body.channel as 'slack' | 'webhook' | 'in-app' | 'email' | undefined,
      target: typeof body.target === 'string' ? body.target : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      minSeverity: body.minSeverity as 'warning' | 'critical' | undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    },
    { orgId, userId },
  );
  if (!updated) return sendError(res, 404, 'Destination not found');

  audit(req, 'alert.destination.update', { targetType: 'alert-destination', targetId: id });
  sendSuccess(res, 200, { destination: toApiDestination(updated) });
});

/** DELETE /api/observability/alert-destinations/:id — soft delete. */
export const deleteAlertDestination = withController('Delete alert destination', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  // Static `observability:write` gate now enforced at the route.

  const id = req.params.id as string;
  const ok = await alertDestinationService.delete(id, { orgId, userId });
  if (!ok) return sendError(res, 404, 'Destination not found');

  // Release the quota slot the create path reserved. Fire-and-forget — a
  // stuck counter resolves on the next period reset.
  releaseFeatureQuota(orgId, 'alertDestinations', logger.warn.bind(logger));

  audit(req, 'alert.destination.delete', { targetType: 'alert-destination', targetId: id });
  sendSuccess(res, 200, undefined, 'Destination deleted');
});

/**
 * POST /api/observability/alert-destinations/:id/test — send a labeled TEST
 * notification to the destination so an operator can verify delivery without
 * waiting for a real alert. Same `observability:write` gate as the other
 * mutations; the lookup is org-scoped so you can't test another org's
 * destination. The send reuses the guarded channel path (see the service).
 */
export const testAlertDestination = withController('Test alert destination', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  // Static `observability:write` gate now enforced at the route. The lookup
  // below is org-scoped so you still can't test another org's destination.

  const id = req.params.id as string;

  let result;
  try {
    result = await alertDestinationService.sendTestNotification(orgId, id, { userId, email: req.user?.email });
  } catch (err) {
    if (err instanceof DestinationNotFoundError) return sendError(res, 404, 'Destination not found');
    throw err;
  }

  audit(req, 'alert.destination.test', {
    targetType: 'alert-destination',
    targetId: id,
    outcome: result.delivered ? 'success' : 'failure',
    details: { delivered: result.delivered, ...(result.error ? { error: result.error } : {}) },
  });

  if (!result.delivered) {
    // Surface a delivery failure as a clean 502 with the reason — not a 500
    // stack. The destination exists and the request was well-formed; the
    // downstream transport (Slack/webhook/email) is what failed.
    return sendError(res, 502, result.error || 'Test notification failed to send');
  }
  sendSuccess(res, 200, { delivered: true }, 'Test notification sent');
});

/**
 * POST /api/observability/alert-webhook — Alertmanager webhook relay.
 *
 * Auth: shared-secret `ALERT_WEBHOOK_TOKEN` env (sent as Bearer token from
 * alertmanager.yml). Not JWT-authenticated — Alertmanager is a server-side
 * service that doesn't have a user identity. The token check is defense in
 * depth on top of NetworkPolicy (`platform` ingress from `alertmanager`).
 *
 * This endpoint intentionally does NOT use the global rate limiter — a quiet
 * Alertmanager fires <1 webhook/min, a noisy one fires bursts but each batches
 * many alerts. The per-destination delivery timeout is the safety net.
 */
export const alertWebhook = withController('Alertmanager webhook relay', async (req, res) => {
  const provided = req.headers.authorization?.replace(/^Bearer\s+/, '') || '';
  const instanceHeader = (req.headers['x-alertmanager-instance'] || '').toString();

  // Resolve which instance (and therefore which token) to compare against.
  // ALERT_WEBHOOK_INSTANCES is the only configuration path — the legacy
  // single-shared-token mode was removed so a token compromise can never
  // spoof alerts beyond one instance's allowlist.
  if (config.alertWebhook.instances.length === 0) {
    logger.warn('Alert webhook called but ALERT_WEBHOOK_INSTANCES is not configured');
    return sendError(res, 503, 'Alert relay not configured');
  }
  if (!instanceHeader) {
    return sendError(res, 401, 'X-Alertmanager-Instance header required');
  }
  const instance = config.alertWebhook.instances.find((i) => i.id === instanceHeader);
  if (!instance) {
    logger.warn('Alert webhook unknown instance', { instance: instanceHeader });
    return sendError(res, 401, 'Unauthorized');
  }
  const expected = instance.token;

  // Constant-time compare to avoid leaking the token via timing. The XOR /
  // bitwise-OR accumulation is the standard formulation — eslint's
  // no-bitwise rule would force a slower / non-constant-time variant, so
  // we suppress it just here.
  if (provided.length !== expected.length) return sendError(res, 401, 'Unauthorized');
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    // eslint-disable-next-line no-bitwise
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (mismatch !== 0) return sendError(res, 401, 'Unauthorized');

  // Minimal validation of the Alertmanager payload shape.
  const body = req.body as Partial<AlertmanagerWebhook>;
  if (!body || !Array.isArray(body.alerts)) {
    return sendError(res, 400, 'Invalid webhook payload');
  }

  // Tenant assertion: if the matched instance has `allowedOrgIds`, every
  // alert in the payload must carry an `org_id` label within that list.
  // Limits the blast radius of a per-instance token compromise — an
  // attacker who steals instance A's token can still only spoof alerts
  // for org A's allowed scope, not for orgs that belong to instance B.
  if (instance?.allowedOrgIds && instance.allowedOrgIds.length > 0) {
    const allowed = new Set(instance.allowedOrgIds);
    for (const alert of body.alerts) {
      const orgId = (alert as { labels?: Record<string, string> }).labels?.org_id;
      if (!orgId || !allowed.has(orgId)) {
        logger.warn('Alert webhook rejected: org_id outside instance allowlist', {
          instance: instance.id,
          alertOrgId: orgId,
        });
        return sendError(res, 403, 'Alert org_id outside instance allowlist');
      }
    }
  }

  // Alertmanager is a privileged server-side relay that legitimately reads
  // every org's destinations to fan out alerts. Once RLS enforcement lands
  // (`ALTER TABLE org_alert_destinations FORCE ROW LEVEL SECURITY`), the
  // default per-request context (`orgId: undefined, isSuperAdmin: false`)
  // wouldn't be able to see any rows. Establish a sysadmin context locally
  // so the relay path keeps working post-enforcement without leaking the
  // sysadmin scope to user-facing endpoints.
  const result = await runWithTenantContext(
    { isSuperAdmin: true },
    () => relayWebhook(body as AlertmanagerWebhook),
  );
  logger.info('Alert relay processed', { ...result, instance: instance?.id });
  sendSuccess(res, 200, result);
});

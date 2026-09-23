// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for per-org alert notification destinations + the Alertmanager
 * webhook relay endpoint.
 *
 *   GET    /api/observability/alert-destinations          — list this org's destinations
 *   GET    /api/observability/alert-destinations/deleted  — restorable tombstones
 *   POST   /api/observability/alert-destinations          — create
 *   PUT    /api/observability/alert-destinations/:id      — update
 *   DELETE /api/observability/alert-destinations/:id      — delete
 *   POST   /api/observability/alert-destinations/:id/restore — undo a delete (step-up)
 *   POST   /api/observability/alert-destinations/:id/purge   — permanent delete (step-up)
 *   POST   /api/observability/alert-webhook           — relay endpoint (called by Alertmanager)
 *
 * The relay is the only path with a non-JWT auth gate: it's called server-to-
 * server from Alertmanager, which lives on the same network as platform.
 * We gate on a shared `ALERT_WEBHOOK_TOKEN` env var instead of a user JWT.
 * The other endpoints all require `requireAuth` and at least org-admin to
 * create/update/delete (org admins own their notification surface).
 */

import { assertSafeUrl, createLogger, errorMessage, safeEqual, sendError, sendSuccess, isSystemAdmin } from '@pipeline-builder/api-core';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { requireAuthContext, requireOrgMembership, withController } from '../helpers/controller-helper.js';
import { releaseFeatureQuota, withFeatureQuota } from '../middleware/quota.js';
import { alertDestinationService, DestinationNotFoundError, toApiDestination } from '../services/alert-destination-service.js';
import { relayWebhook, type AlertmanagerWebhook } from '../services/alert-relay.js';
import { isValidEmail } from '../utils/email-address.js';
import { createAlertDestinationSchema, updateAlertDestinationSchema } from '../utils/validation-observability.js';
import { validateBody } from '../utils/validation.js';

const logger = createLogger('alert-destinations-controller');

/** Slack/webhook URL length cap (see config.observability). */
const { alertDestinationMaxTarget: MAX_TARGET } = config.observability;


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
    // Use the SAME rule as registration/invites. The local copy additionally
    // required a TLD, so an address the platform happily registers — including
    // its own shipped default, `admin@internal` — was rejected as an alert
    // destination, with no stated reason for the stricter rule here.
    if (!isValidEmail(target)) return 'Email target must be a valid email address';
    if (target.length > MAX_TARGET) return `Email address exceeds ${MAX_TARGET} chars`;
    return null;
  }
  if (channel === 'in-app') {
    return null;
  }
  return 'channel must be slack, webhook, in-app, or email';
}

/**
 * Create/update-time SSRF check for the generic `webhook` channel: an org
 * controls the URL, so reject any host that is — or resolves to — a
 * private/loopback/link-local/metadata address before we ever STORE it.
 * Returns an error string (for a 400) or null when the target is safe / not a
 * webhook. Slack targets are already host-allowlisted to hooks.slack.com by
 * `validateChannelTarget`, so they need no DNS check.
 *
 * This is `assertSafeUrl`'s one sanctioned use: pure validation with nothing
 * about to connect. The DELIVERY path does not re-run it — it uses api-core's
 * `safeFetch`, which re-resolves, pins the vetted address into the socket and
 * refuses redirects, so a host re-pointed at an internal address after this
 * check still can't be reached.
 */
async function checkWebhookTargetSafe(channel: string | undefined, target: string): Promise<string | null> {
  if (channel !== 'webhook' || !target) return null;
  try {
    await assertSafeUrl(target);
    return null;
  } catch (err) {
    return `Webhook target rejected: ${errorMessage(err)}`;
  }
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
 * GET /api/observability/alert-destinations/deleted — this org's restorable
 * tombstones ("recently deleted"). Same `observability:read` gate + org scope as
 * the live list, and the SAME target masking: a deleted Slack hook URL is still
 * a bearer-equivalent secret.
 */
export const listDeletedAlertDestinations = withController('List deleted alert destinations', async (req, res) => {
  const orgId = requireOrgMembership(req, res);
  if (!orgId) return;

  const destinations = await alertDestinationService.listDeletedForOrg(orgId);
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

  const body = validateBody(createAlertDestinationSchema, req.body, res);
  if (!body) return;
  const { channel, label, target, minSeverity, enabled } = body;
  if (channel !== 'in-app') {
    const err = validateChannelTarget(channel, target);
    if (err) return sendError(res, 400, err);
    const ssrfErr = await checkWebhookTargetSafe(channel, target);
    if (ssrfErr) return sendError(res, 400, ssrfErr);
  }

  // Per-org cap on alert destinations. Reserve atomically before insert so
  // two concurrent creates at the limit can't both succeed.
  await withFeatureQuota(res, orgId, 'alertDestinations', async () => {
    const created = await alertDestinationService.create(
      { channel, target, label, minSeverity, enabled: enabled ?? true },
      { orgId, userId },
    );

    audit(req, 'alert.destination.create', {
      targetType: 'alert-destination',
      targetId: created.id,
      details: { channel: created.channel, label: created.label, minSeverity: created.minSeverity },
    });
    sendSuccess(res, 201, { destination: toApiDestination(created) });
  });
});

/** PUT /api/observability/alert-destinations/:id — update. */
export const updateAlertDestination = withController('Update alert destination', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  // Static `observability:write` gate now enforced at the route.

  const id = req.params.id as string;
  const body = validateBody(updateAlertDestinationSchema, req.body, res);
  if (!body) return;

  if (body.target !== undefined && body.target !== '') {
    // Validate against the new channel if supplied, otherwise look up the existing channel.
    let channel: string;
    if (body.channel !== undefined) {
      channel = body.channel;
    } else {
      const existing = await alertDestinationService.findById(id, orgId);
      if (!existing) return sendError(res, 404, 'Destination not found');
      channel = existing.channel;
    }
    const err = validateChannelTarget(channel, body.target);
    if (err) return sendError(res, 400, err);
    const ssrfErr = await checkWebhookTargetSafe(channel, body.target);
    if (ssrfErr) return sendError(res, 400, ssrfErr);
  } else if (body.channel !== undefined) {
    // Channel changed but no new target supplied — re-validate the STORED target
    // against the new channel's rules, else a webhook target (e.g. an internal
    // URL) could be relabeled as slack/email and bypass the channel allowlist.
    const existing = await alertDestinationService.findById(id, orgId);
    if (!existing) return sendError(res, 404, 'Destination not found');
    const err = validateChannelTarget(body.channel, existing.target);
    if (err) return sendError(res, 400, err);
    const ssrfErr = await checkWebhookTargetSafe(body.channel, existing.target);
    if (ssrfErr) return sendError(res, 400, ssrfErr);
  }

  const updated = await alertDestinationService.update(id, body, { orgId, userId });
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
  releaseFeatureQuota(orgId, 'alertDestinations', logger.warn.bind(logger), null);

  audit(req, 'alert.destination.delete', { targetType: 'alert-destination', targetId: id });
  sendSuccess(res, 200, undefined, 'Destination deleted');
});

/** POST /api/observability/alert-destinations/:id/restore — undo a soft-delete
 *  within the retention window. Same `observability:write` gate as delete, plus
 *  step-up (reverses a destructive action). Org-scoped in the service. */
export const restoreAlertDestination = withController('Restore alert destination', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  const id = req.params.id as string;

  // Restore re-adds a live row → re-reserve the feature slot delete released, so
  // delete→restore→create can't drift an org past its alertDestinations cap.
  await withFeatureQuota(res, orgId, 'alertDestinations', async () => {
    const ok = await alertDestinationService.restore(id, { orgId, userId });
    if (!ok) {
      sendError(res, 404, 'Destination not found');
      return false;
    }
    audit(req, 'alert.destination.restore', { targetType: 'alert-destination', targetId: id });
    sendSuccess(res, 200, undefined, 'Destination restored');
    return true;
  });
});

/**
 * POST /api/observability/alert-destinations/:id/purge — PERMANENT hard-delete
 * of a tombstone, finalizing now what the retention sweep would do at
 * `purge_after`. Same `observability:write` + step-up gate as restore
 * (irreversible), org-scoped in the service. 404 when the id is unknown or still
 * live — a live destination must be soft-deleted first.
 *
 * No quota release: delete already released the `alertDestinations` slot.
 */
export const purgeAlertDestination = withController('Purge alert destination', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { orgId } = ctx;

  const id = req.params.id as string;

  // Load the tombstone first: gates on own-org scope + genuine soft-delete, and
  // captures the label for the audit record before the row is destroyed. Never
  // the target — that is a secret and has no place in the audit trail.
  const existing = await alertDestinationService.findDeletedById(id, orgId);
  if (!existing) return sendError(res, 404, 'Destination not found');

  const ok = await alertDestinationService.purgeById(id, orgId);
  if (!ok) return sendError(res, 404, 'Destination not found');

  audit(req, 'alert.destination.purge', {
    targetType: 'alert-destination',
    targetId: id,
    affectedOrgId: orgId,
    details: { channel: existing.channel, label: existing.label },
  });
  sendSuccess(res, 200, undefined, 'Destination permanently deleted');
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
    // Surface a delivery failure as a clean 502 with a GENERIC reason — never
    // the downstream HTTP status or host. Reflecting `result.error` here would
    // turn `/test` into an oracle: an org admin could probe internal endpoints
    // (metadata IP, in-cluster services) and read back their status codes /
    // reachability. The specific reason is retained in the audit log above for
    // operators; the caller only learns delivery did not succeed.
    return sendError(res, 502, 'Test notification failed to send');
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
  // Current token, or — during a rotation (ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS)
  // — the outgoing one. Both are compared (no short-circuit) so timing doesn't
  // reveal which matched.
  const matchesCurrent = safeEqual(provided, instance.token);
  const matchesPrevious = instance.previousToken ? safeEqual(provided, instance.previousToken) : false;
  if (!matchesCurrent && !matchesPrevious) return sendError(res, 401, 'Unauthorized');

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

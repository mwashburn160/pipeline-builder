// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /observability/oncall-webhook — the Alertmanager leg of on-call paging.
 *
 * WHY A SEPARATE ROUTE FROM THE RELAY. `alertWebhook` next door fans an alert out
 * to a TENANT's configured destinations and its Alertmanager route matches
 * `tenancy = "org"`. Support alerts are `tenancy: platform`, so they never reach
 * it. This route is the platform-side counterpart: it takes alerts the ops team
 * owns and pages a human.
 *
 * WHY IT POINTS AT THE PRODUCT AND NOT STRAIGHT AT PAGERDUTY. The obvious wiring
 * is Alertmanager → PagerDuty via `pagerduty_configs`, and it cannot be built
 * here. `config/alertmanager/alertmanager.yml` is in the deploy contract's
 * REQUIRED_IDENTICAL set and asserted byte-identical across targets, and
 * Alertmanager has no templating — so a route that exists only when paging is
 * enabled would need a second copy of the whole config, in the shape of
 * `admin-consoles-disabled.conf`. Routing through the product instead means the
 * route is ALWAYS present and `ONCALL_ENABLED` is honoured here, where a
 * disabled client accepts and drops. Alertmanager sees a 200 either way, so a
 * deployment that does not page collects no notification failures.
 *
 * It also costs nothing to reach: this is the same service, port and
 * `relay-token` the existing relay already uses, so there is no new Secret, no
 * NetworkPolicy rule and no `istio-internal-routes.yaml` entry — and it reuses
 * `authenticateAlertmanager`, which was already extracted because the PVC
 * auto-expand endpoint needs the identical check.
 *
 * NARROW BY DESIGN: `severity: critical` AND `component: support`. The
 * Alertmanager route matches the same pair, and this re-checks it rather than
 * trusting the routing — a misrouted or replayed payload must not page. Widening
 * to all criticals would page on cluster problems a Slack channel already handles
 * well enough, and the fastest way to make a pager ignored is to let it fire for
 * things nobody is contractually on the hook for.
 */

import {
  SYSTEM_ORG_ID,
  ackLatencySeconds,
  actorId,
  createLogger,
  fetchRotaCoverage,
  onCallInboundConfig,
  pagerDutyConfig,
  parseOnCallWebhook,
  sendError,
  sendPagerDutyEvent,
  sendSuccess,
  verifyPagerDutySignature,
  type PagerDutyEvent,
} from '@pipeline-builder/api-core';
import { incCounter, observe } from '@pipeline-builder/api-server';
import { authenticateAlertmanager } from '../helpers/alertmanager-auth.js';
// Platform's OWN hash-chained append, not api-core's `recordAudit` — that one
// is the REMOTE client the other services post with, and platform writing
// through it would make an HTTP call to itself.
import { recordAuditEvent } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import type { AlertmanagerWebhook } from '../services/alert-relay.js';

const logger = createLogger('oncall-webhook');

/** The support pair this route pages for. Re-checked, not assumed from routing. */
const PAGE_SEVERITY = 'critical';
const PAGE_COMPONENT = 'support';

/**
 * Alerts about alert DELIVERY, labelled `delivery_meta: "true"` on the rule.
 *
 * These page too, and it is a narrow widening rather than the start of "page on
 * everything critical". A Slack receiver with no URL cannot deliver "Slack has
 * no URL", and a pager with no routing key cannot page "the pager has no routing
 * key" — so routing these through the destinations whose failure they report is
 * circular, and this endpoint is the one place that accepts them unconditionally.
 *
 * Alerting being broken is also the single condition that makes every other
 * alert meaningless, which is why it earns the pager rather than merely a log.
 */
const META_LABEL = 'delivery_meta';

/** One alert from an Alertmanager payload, reduced to what the decision needs. */
export interface OnCallAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  fingerprint?: string;
}

/**
 * Whether an alert pages, and as what — extracted as a PURE function because it
 * is where every branch lives, and the handler around it is plumbing.
 *
 * Returns `null` for an alert that should be ignored, which the caller counts
 * rather than silently drops.
 */
export function pageDecision(alert: OnCallAlert): PagerDutyEvent | null {
  const labels = alert.labels ?? {};
  const isSupportCritical = labels.severity === PAGE_SEVERITY && labels.component === PAGE_COMPONENT;
  const isDeliveryMeta = labels[META_LABEL] === 'true';
  if (!isSupportCritical && !isDeliveryMeta) return null;

  return {
    // Alertmanager's own fingerprint keys this leg, so ITS grouping and the
    // per-case sweep's `case:<id>` keys can never collide over one incident. A
    // payload without one falls back to the alertname — coarser, but still
    // deduplicating rather than paging per evaluation.
    dedupKey: `am:${alert.fingerprint ?? labels.alertname ?? 'unknown'}`,
    action: alert.status === 'resolved' ? 'resolve' : 'trigger',
    // Stated rather than left to the default, so the per-case sweep and this leg
    // stay distinguishable in `oncall_pages_total` even if the default changes.
    trigger: 'alertmanager',
    severity: 'critical',
    summary: alert.annotations?.summary ?? labels.alertname ?? 'Support alert',
    source: `pipeline-builder/${labels.tenancy ?? 'platform'}`,
    // The component the alert actually carries: a delivery meta-alert is
    // `observability`, not `support`, and mislabelling it would make the two
    // indistinguishable in an incident timeline.
    component: labels.component ?? PAGE_COMPONENT,
    class: isDeliveryMeta ? 'alert.delivery' : labels.alertname,
    // IDS AND LABELS ONLY. The on-call permission is system-org scoped and
    // grants no tenant access, so tenant CONTENT must not travel to a third
    // party through this path. An alert annotation is ours, not a tenant's.
    customDetails: {
      alertname: labels.alertname ?? '',
      startsAt: alert.startsAt ?? '',
      ...(labels.org_id ? { orgId: labels.org_id } : {}),
    },
  };
}

export const oncallWebhook = withController('On-call paging webhook', async (req, res) => {
  const auth = authenticateAlertmanager(req);
  if (!auth.ok) return sendError(res, auth.status, auth.message);

  const body = req.body as Partial<AlertmanagerWebhook>;
  if (!body || !Array.isArray(body.alerts)) {
    return sendError(res, 400, 'Invalid webhook payload');
  }

  let paged = 0;
  let resolved = 0;
  let ignored = 0;

  // TRUNCATION. `max_alerts: 64` on the receiver makes Alertmanager truncate
  // rather than reject — the excess alerts are dropped from the payload and the
  // count arrives here instead. Nothing read it before, so a wide outage
  // delivered a silently partial batch. It barely matters for paging (dedup
  // collapses a burst into one incident anyway) and matters a lot for knowing
  // the batch was partial, so it is counted rather than inferred.
  const truncated = Number((req.body as { truncatedAlerts?: number }).truncatedAlerts ?? 0);
  if (truncated > 0) {
    incCounter('oncall_alerts_truncated_total', {}, truncated);
    logger.warn('Alertmanager truncated the batch before delivering it', {
      truncated, delivered: body.alerts.length,
    });
  }

  for (const alert of body.alerts) {
    const event = pageDecision(alert);
    if (!event) {
      // Not a pageable alert. `severity: info` / `none` alerts route here
      // DELIBERATELY: Alertmanager's `default` receiver carries no config at
      // all, so anything unrouted was silently discarded rather than
      // "logged-only" as its comment claimed. Counting them here is what makes
      // them exist.
      ignored += 1;
      incCounter('oncall_alerts_ignored_total', { severity: alert.labels?.severity ?? 'none' });
      continue;
    }

    const result = await sendPagerDutyEvent(event);
    if (event.action === 'resolve') resolved += 1;
    else paged += 1;
    if (!result.ok) {
      // Logged, not thrown, and the response stays 200: Alertmanager retries a
      // non-2xx, and retrying a page PagerDuty already rejected for a bad key
      // just multiplies the failure. The counter inside the client is what makes
      // this alertable.
      logger.error('On-call dispatch failed', { dedupKey: event.dedupKey, action: event.action, error: result.error });
    }
  }

  logger.info('On-call webhook processed', { paged, resolved, ignored, instance: auth.instance?.id });
  sendSuccess(res, 200, { paged, resolved, ignored });
});

/**
 * POST /observability/oncall-ack — what the provider tells US.
 *
 * WHY THIS DIRECTION EXISTS AT ALL. Everything above pushes outward and can
 * only ever report that a page was ACCEPTED, which is a 202 and not a phone
 * ringing. The two facts worth having come back the other way: somebody picked
 * it up (and who), and the first responder did not (an escalation). Without
 * them `oncall_pages_total{outcome="accepted"}` is the whole evidence base, and
 * it cannot distinguish a working rota from a silent one.
 *
 * RAW BODY, NOT PARSED. The signature is an HMAC over the exact bytes
 * PagerDuty sent, so `express.raw` is mounted for this path in `index.ts` and
 * the JSON is parsed here. Verifying a re-serialized object fails every time —
 * key order and whitespace differ — and the obvious way out of that is to stop
 * verifying, which is why the coupling is stated in both places.
 *
 * FAILS CLOSED WITH NO SECRET. An unverified webhook that writes an audit
 * record and a latency metric lets anyone who learns the URL assert that a page
 * was handled. That is the single worst lie available in this feature: it makes
 * the system report coverage it does not have.
 */
export const oncallAckWebhook = withController('On-call acknowledgement webhook', async (req, res) => {
  const cfg = onCallInboundConfig();
  const raw: Buffer | string = Buffer.isBuffer(req.body) ? req.body : (typeof req.body === 'string' ? req.body : '');
  const signature = req.header('X-PagerDuty-Signature');

  if (!verifyPagerDutySignature(raw, signature, cfg.webhookSecret)) {
    // 401 and not 403: the caller has not proven who it is. Counted so a
    // misconfigured secret is visible as a stream of refusals rather than as
    // acks that simply never arrive — the failure is otherwise indistinguishable
    // from a quiet rota.
    incCounter('oncall_ack_webhook_total', { outcome: cfg.webhookSecret ? 'bad_signature' : 'no_secret' });
    if (!cfg.webhookSecret) {
      logger.error('An on-call acknowledgement arrived but PAGERDUTY_WEBHOOK_SECRET is empty — refused');
    }
    return sendError(res, 401, 'Invalid signature');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    incCounter('oncall_ack_webhook_total', { outcome: 'malformed' });
    return sendError(res, 400, 'Invalid webhook payload');
  }

  const event = parseOnCallWebhook(parsed);
  if (!event) {
    incCounter('oncall_ack_webhook_total', { outcome: 'unrecognized' });
    return sendSuccess(res, 200, { handled: false });
  }

  // The agent as the PROVIDER knows them. Recorded as-is and never resolved to
  // a local user: the provider owns contact methods and their verification, and
  // inventing a mapping would assert an identity this system cannot attest to.
  // What the audit trail gains is still the thing that was missing — a named
  // actor, hash-chained, instead of a screenshot of somebody's phone.
  const actor = event.agentId ? `pagerduty:${event.agentId}` : 'pagerduty:unknown';
  const latency = ackLatencySeconds(event);

  switch (event.eventType) {
    case 'incident.acknowledged': {
      incCounter('oncall_ack_webhook_total', { outcome: 'acknowledged' });
      // Only when it could be computed. A missing timestamp must not become a
      // zero — that lands in the first bucket and reads as an instant
      // acknowledgement, the most flattering possible lie about response time.
      if (latency !== undefined) observe('oncall_page_ack_seconds', {}, latency);
      recordAuditEvent({
        action: 'support.oncall.acknowledged',
        actorId: actor,
        orgId: SYSTEM_ORG_ID,
        targetType: 'oncall_page',
        targetId: event.dedupKey ?? event.incidentId ?? 'unknown',
        details: {
          incidentId: event.incidentId ?? '',
          agent: event.agentSummary ?? '',
          ...(latency !== undefined ? { ackSeconds: Math.round(latency) } : {}),
        },
      });
      break;
    }
    case 'incident.escalated': {
      incCounter('oncall_ack_webhook_total', { outcome: 'escalated' });
      // The provider does not name the rungs in a way this side can trust, so
      // the counter records THAT an escalation happened rather than inventing a
      // from/to pair out of a summary string. This is the record that the first
      // responder did not answer, which is the fact a rota gets adjusted on.
      incCounter('oncall_escalations_total', {});
      recordAuditEvent({
        action: 'support.oncall.escalated',
        actorId: actor,
        orgId: SYSTEM_ORG_ID,
        targetType: 'oncall_page',
        targetId: event.dedupKey ?? event.incidentId ?? 'unknown',
        details: { incidentId: event.incidentId ?? '', agent: event.agentSummary ?? '' },
      });
      break;
    }
    case 'incident.unacknowledged':
    case 'incident.resolved':
      // Counted, not audited. A resolve is already OUR act in the per-case path
      // (the reply that stopped the clock) or the alert clearing, so auditing
      // the provider's echo would double-record an event this system caused.
      incCounter('oncall_ack_webhook_total', { outcome: event.eventType === 'incident.resolved' ? 'resolved' : 'unacknowledged' });
      break;
    default:
      incCounter('oncall_ack_webhook_total', { outcome: 'ignored' });
      return sendSuccess(res, 200, { handled: false });
  }

  logger.info('On-call acknowledgement processed', { eventType: event.eventType, dedupKey: event.dedupKey });
  sendSuccess(res, 200, { handled: true });
});

/**
 * GET /observability/oncall-status — "will we actually be paged?"
 *
 * The one thing a product surface can answer that a shell cannot, for somebody
 * who holds `oncall:manage` and no cluster access. It reports the POSTURE and
 * never a credential: whether paging is declared on, whether a routing key
 * exists, whether the inbound and rota credentials exist, and whether anyone is
 * currently scheduled.
 *
 * BOOLEANS, NOT VALUES. `configured` rather than the key, because a routing key
 * is a bearer credential: anyone holding it can raise incidents on the service.
 * An endpoint that reads one back to an authenticated caller turns a read
 * permission into a credential grant.
 */
export const oncallStatus = withController('On-call status', async (_req, res) => {
  const pd = pagerDutyConfig();
  const inbound = onCallInboundConfig();
  // Asked live rather than read from the gauge: a caller checking the posture is
  // usually about to change something, and a cached answer is the wrong one at
  // exactly that moment.
  const rota = await fetchRotaCoverage(inbound);
  sendSuccess(res, 200, {
    enabled: pd.enabled,
    provider: pd.provider,
    routingKeyConfigured: pd.routingKey.length > 0,
    endpointConfigured: pd.endpoint.length > 0,
    ackWebhookConfigured: inbound.webhookSecret.length > 0,
    rotaReadable: rota.known,
    rotaEntries: rota.entries,
    lookaheadHours: inbound.lookaheadHours,
    // The honest summary, and the only field worth acting on: everything else
    // can be true while this is false.
    wouldPage: pd.enabled && pd.routingKey.length > 0 && pd.endpoint.length > 0,
  });
});

/**
 * POST /observability/oncall-test — prove the pager works, now.
 *
 * Without this, the only way to learn whether paging works is an incident, and
 * the only way to learn it does NOT is an incident nobody heard about. A 202
 * from Events v2 still is not proof a phone rang — so the response says what
 * was achieved and no more, and the audit record names who caused somebody's
 * phone to ring at whatever time it is.
 *
 * `dedup_key` is `test:<timestamp>` so a test can never collapse onto, or
 * resolve, a REAL incident — a fixed key would make the second test silently
 * do nothing, and a key colliding with `am:`/`case:` would close a live page.
 */
export const oncallTest = withController('On-call test page', async (req, res) => {
  const result = await sendPagerDutyEvent({
    dedupKey: `test:${Date.now()}`,
    action: 'trigger',
    trigger: 'alertmanager',
    severity: 'info',
    summary: 'Pipeline Builder on-call test page (no incident)',
    source: 'pipeline-builder/platform',
    component: 'support',
    class: 'oncall.test',
    // `sub`, which IS the user id on this token — `JwtPayload` has no `id`.
    // Sent so the page itself names who caused it, not only the audit row: the
    // person whose phone rings at 3am is reading the notification, not the
    // trail.
    customDetails: { test: true, requestedBy: req.user?.sub ?? '' },
  });
  // RECORDED HERE, not by `audited()` on the route. That marker only TAGS the
  // route table for reviewers — it is a no-op pass-through and writes nothing —
  // so declaring the action there and stopping would advertise an audit trail
  // that does not exist. Written whatever the outcome, including a skip: "who
  // tried to page the on-call at 3am" is the question, and it is answered the
  // same way whether or not the knob let it through.
  recordAuditEvent({
    action: 'support.oncall.test',
    actorId: actorId({ userId: req.user?.sub }),
    orgId: SYSTEM_ORG_ID,
    targetType: 'oncall_page',
    targetId: 'test',
    details: {
      sent: result.ok && !result.skipped,
      skipped: result.skipped === true,
      ...(result.status !== undefined ? { status: result.status } : {}),
    },
  });

  // `skipped` is the knob being off, which is a successful answer to "what
  // happens today" rather than a failure to report.
  sendSuccess(res, result.ok ? 200 : 502, {
    sent: result.ok && !result.skipped,
    skipped: result.skipped === true,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  });
});

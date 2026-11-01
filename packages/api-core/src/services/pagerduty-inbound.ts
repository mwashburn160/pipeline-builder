// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The INBOUND half of on-call: what the provider tells us back.
 *
 * Everything else in this feature pushes outward — an alert fires, a case
 * approaches its deadline, an event goes to Events v2. That direction can only
 * ever report that a page was ACCEPTED, which is a 202 and not a phone ringing.
 * This module is the only source of the two facts that actually matter:
 *
 *  - SOMEBODY PICKED IT UP, and who. `oncall_pages_total{outcome="accepted"}`
 *    cannot answer "was anyone awake at 03:14"; an acknowledgement can, and
 *    bound to a user id it becomes an audit record rather than a hint. The
 *    provider's own ack view is not auditable here — a click on a link in their
 *    UI is not an identity this system can attest to — so the webhook is what
 *    turns their state change into our record.
 *  - NOBODY IS SCHEDULED. A rota with a hole next Tuesday has to be visible on
 *    MONDAY, not at 02:00 Tuesday. That is an absence check, and absence checks
 *    are the ones this codebase keeps finding it had missed. It is answered by
 *    READING the provider's schedule rather than owning one.
 *
 * TWO CREDENTIALS, DELIBERATELY SEPARATE AND BOTH OPTIONAL.
 * `PAGERDUTY_WEBHOOK_SECRET` verifies what they send us. `PAGERDUTY_API_TOKEN`
 * is a REST token for reading the rota and is strictly more powerful than the
 * per-service integration key used for sending — an integration key can only
 * create events on one service, while a REST token reads incidents, schedules
 * and users account-wide. So the rota check is opt-in on its own credential,
 * and a deployment that does not want to hand over a REST token simply does not
 * get the gauge. It must never be inferred from the routing key.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { envInt, envStr } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/response.js';
import { safeFetch } from '../utils/ssrf.js';

const logger = createLogger('pagerduty-inbound');

export const PAGERDUTY_API_URL = 'https://api.pagerduty.com';

/**
 * Verify a PagerDuty v3 webhook signature.
 *
 * The scheme: `X-PagerDuty-Signature: v1=<lowercase hex>`, an HMAC-SHA256 over
 * the RAW request body. Three properties of it are easy to get wrong and each
 * one is a hole:
 *
 *  - THE RAW BODY, not a re-serialized object. `JSON.stringify(req.body)` after
 *    a JSON parser has run produces different bytes (key order, whitespace,
 *    number formatting), so every signature fails and the obvious "fix" is to
 *    stop checking. The route therefore mounts `express.raw`.
 *  - MULTIPLE SIGNATURES. The header may carry several comma-separated `v1=`
 *    values, which is how PagerDuty rotates a secret without downtime. Checking
 *    only the first breaks during their rotation, so ANY match is accepted —
 *    the same overlap this repo already runs for its own relay token.
 *  - CONSTANT TIME. Compared with `timingSafeEqual` on equal-length buffers,
 *    because a byte-at-a-time comparison leaks the expected digest to anyone
 *    who can post here repeatedly.
 *
 * NO SECRET MEANS NO. An unverified webhook that moves an audit record and a
 * metric is a way for anyone who learns the URL to assert that a page was
 * handled — the one lie that would make the whole feature report coverage it
 * does not have. Fails closed.
 */
export function verifyPagerDutySignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  for (const part of header.split(',')) {
    const value = part.trim();
    if (!value.startsWith('v1=')) continue;
    const given = Buffer.from(value.slice(3), 'utf8');
    // Length-guarded: timingSafeEqual THROWS on a length mismatch, and an
    // attacker controls this length.
    if (given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf)) return true;
  }
  return false;
}

export interface OnCallInboundConfig {
  webhookSecret: string;
  apiToken: string;
  apiUrl: string;
  /** How far ahead the rota check looks. The gap alert is only as useful as this. */
  lookaheadHours: number;
  /** Escalation policy ids to check coverage for; empty means the whole account. */
  escalationPolicyIds: string[];
  timeoutMs: number;
}

export function onCallInboundConfig(): OnCallInboundConfig {
  return {
    webhookSecret: envStr('PAGERDUTY_WEBHOOK_SECRET', ''),
    apiToken: envStr('PAGERDUTY_API_TOKEN', ''),
    apiUrl: envStr('PAGERDUTY_API_URL', PAGERDUTY_API_URL),
    // 48 hours: far enough to catch a hole over a weekend on the Friday, and
    // short enough that a rota maintained a week out does not alert forever.
    lookaheadHours: envInt('ONCALL_SCHEDULE_GAP_LOOKAHEAD_HOURS', 48, { min: 1, max: 2160 }),
    escalationPolicyIds: envStr('PAGERDUTY_ESCALATION_POLICY_IDS', '')
      .split(',').map((x) => x.trim()).filter(Boolean),
    timeoutMs: envInt('ONCALL_EVENTS_TIMEOUT_MS', 5000, { min: 1 }),
  };
}

export interface RotaCoverage {
  /** Whether the question could be answered at all. */
  known: boolean;
  /** Distinct on-call entries covering any part of the window. */
  entries: number;
  /** Seconds of the lookahead window with nobody on call, 0 when fully covered. */
  uncoveredSeconds: number;
}

/**
 * Ask the provider whether anyone is on call across the lookahead window.
 *
 * WHAT THIS CAN AND CANNOT CONCLUDE, because the difference decides whether the
 * alert built on it is honest. `GET /oncalls?since&until` returns the on-call
 * entries OVERLAPPING a window; it does not return the holes. Reconstructing
 * exact holes would mean stitching every entry's interval, and an entry's
 * `start`/`end` are null for an always-on policy — so a precise
 * "uncovered seconds" is not available from this endpoint without a lot of
 * arithmetic that would be wrong in the always-on case.
 *
 * So this answers the question it CAN answer exactly: is the window covered at
 * all. Zero entries over the next N hours means nobody is scheduled, which is
 * the failure worth paging about and the one a rota maintainer actually makes.
 * `uncoveredSeconds` is therefore the whole window or nothing, and it is a
 * deliberate under-report rather than a guess — a partial hole reads as covered
 * here, and claiming otherwise would be inventing precision.
 *
 * `known: false` when there is no API token or the call fails, and the caller
 * must publish NOTHING in that case. A gauge of 0 would say "fully covered",
 * which is exactly the lie this check exists to prevent.
 */
export async function fetchRotaCoverage(cfg: OnCallInboundConfig = onCallInboundConfig()): Promise<RotaCoverage> {
  const windowSeconds = cfg.lookaheadHours * 3600;
  if (!cfg.apiToken) return { known: false, entries: 0, uncoveredSeconds: 0 };

  const since = new Date();
  const until = new Date(since.getTime() + windowSeconds * 1000);
  const params = new URLSearchParams({
    since: since.toISOString(),
    until: until.toISOString(),
    limit: '50',
  });
  for (const id of cfg.escalationPolicyIds) params.append('escalation_policy_ids[]', id);

  try {
    const resp = await safeFetch(`${cfg.apiUrl}/oncalls?${params.toString()}`, {
      method: 'GET',
      headers: {
        // PagerDuty's REST scheme. `Accept` pins the API version; without it
        // the response shape is whatever their default happens to be.
        Authorization: `Token token=${cfg.apiToken}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      timeoutMs: cfg.timeoutMs,
    });
    if (resp.redirected || !resp.ok) {
      logger.warn('Could not read the on-call rota', { status: resp.status, redirected: resp.redirected });
      return { known: false, entries: 0, uncoveredSeconds: 0 };
    }
    const body = await resp.json() as { oncalls?: unknown[] };
    const entries = Array.isArray(body.oncalls) ? body.oncalls.length : 0;
    return { known: true, entries, uncoveredSeconds: entries > 0 ? 0 : windowSeconds };
  } catch (err) {
    logger.warn('Could not reach the on-call rota API', { error: errorMessage(err) });
    return { known: false, entries: 0, uncoveredSeconds: 0 };
  }
}

/** The webhook events this system acts on. Everything else is counted and dropped. */
export type OnCallWebhookEventType =
  | 'incident.acknowledged'
  | 'incident.escalated'
  | 'incident.resolved'
  | 'incident.unacknowledged';

export interface OnCallWebhookEvent {
  eventType: string;
  /** Provider incident id — the join back to what we sent. */
  incidentId?: string;
  /** Our own `dedup_key`, when the provider echoes it. */
  dedupKey?: string;
  /** Who acted, as the provider knows them. An id and an email, never a session. */
  agentId?: string;
  agentSummary?: string;
  /** When the incident was created, for the ack-latency measurement. */
  createdAt?: string;
  occurredAt?: string;
}

/**
 * Reduce a v3 webhook body to the fields this system uses.
 *
 * Returns `null` for anything that is not a recognised incident event, which
 * the caller COUNTS rather than drops silently — an unrecognised event type is
 * usually a subscription configured wider than the handler, and a count is how
 * that becomes visible instead of being inferred from nothing happening.
 */
export function parseOnCallWebhook(body: unknown): OnCallWebhookEvent | null {
  const event = (body as { event?: Record<string, unknown> })?.event;
  if (!event || typeof event.event_type !== 'string') return null;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const agency = (event.agent ?? {}) as Record<string, unknown>;
  return {
    eventType: event.event_type,
    incidentId: typeof data.id === 'string' ? data.id : undefined,
    // PagerDuty echoes the trigger's dedup_key on the incident, which is the
    // only link back to WHICH case or alert this was — their incident id is
    // theirs and means nothing on this side.
    dedupKey: typeof data.dedup_key === 'string' ? data.dedup_key : undefined,
    agentId: typeof agency.id === 'string' ? agency.id : undefined,
    agentSummary: typeof agency.summary === 'string' ? agency.summary : undefined,
    createdAt: typeof data.created_at === 'string' ? data.created_at : undefined,
    occurredAt: typeof event.occurred_at === 'string' ? event.occurred_at : undefined,
  };
}

/**
 * Seconds between the incident being raised and this event.
 *
 * Returns `undefined` rather than 0 when either timestamp is missing or the
 * arithmetic is nonsense: a 0 would land in the first histogram bucket and read
 * as an instant acknowledgement, which is the most flattering possible lie
 * about response time.
 */
export function ackLatencySeconds(event: OnCallWebhookEvent): number | undefined {
  if (!event.createdAt || !event.occurredAt) return undefined;
  const from = new Date(event.createdAt).getTime();
  const to = new Date(event.occurredAt).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;
  return (to - from) / 1000;
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PagerDuty Events API v2 — the only thing in this repo that can wake a human.
 *
 * WHY THIS EXISTS. `SUPPORT_PREMIUM_ENABLED` ships on, and premium sells a first
 * response "within 8 hours, any day" — the one response target in
 * `SUPPORT_RESPONSE_TARGETS` with no business-hours exemption, so its clock runs
 * through nights and weekends. Before this, the only thing watching it was
 * `SupportPremiumFirstResponseAtRisk` routed to a Slack channel, which satisfies
 * the routing and not the obligation: the alert's own description says "if no
 * rota is awake, that is the cause".
 *
 * WHY NO SDK. The whole protocol is one HTTPS POST of JSON to a fixed endpoint.
 * An SDK for that is a dependency for nothing in a repo that digest-pins,
 * OSV-scans and enforces `minimumReleaseAge`.
 *
 * WHAT THE PROVIDER OWNS, AND WHY THAT DECIDED THE DESIGN. `dedupKey` plus
 * `event_action` means PagerDuty holds the incident state, so three things this
 * repo would otherwise have had to build are simply theirs:
 *
 *  - DEDUPLICATION. Fifty premium cases breaching together — the normal shape
 *    after any outage — is one incident, not fifty pages. Fifty pages and no
 *    pages are the same thing.
 *  - RESOLUTION. `resolve` on the same key closes it, so a case that finally
 *    gets a first response stops paging without a local state machine.
 *  - CONTACT METHODS and their verification, the rota, and escalation.
 *
 * So there is no rota in this codebase on purpose. What stays here is the
 * TRIGGER, because the product knows something PagerDuty cannot: a support case
 * carries an exact `response_due_at`, which beats a p90 histogram that can only
 * say the distribution already drifted.
 *
 * NEVER THROWS. Every caller is on an alerting path — a webhook handler or a
 * sweep — and an exception there turns "could not page" into "crashed instead of
 * paging". Failures come back as a typed result and are counted.
 */

import { envBool, envInt, envStr } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';
import { safeFetch } from '../utils/ssrf.js';

const logger = createLogger('pagerduty');

/** PagerDuty's own severity enum. Ours map straight onto it. */
export type PagerDutySeverity = 'critical' | 'error' | 'warning' | 'info';

/** The three follow-up actions a single `dedupKey` moves through. */
export type PagerDutyAction = 'trigger' | 'acknowledge' | 'resolve';

export interface PagerDutyEvent {
  /**
   * The key that ties a trigger to its later acknowledge/resolve. Stable and
   * derived, never random: `case:<caseId>` for the per-case sweep,
   * Alertmanager's own group fingerprint for the alert leg — so its grouping and
   * ours cannot fight over the same incident.
   */
  dedupKey: string;
  action: PagerDutyAction;
  /**
   * WHICH leg raised this, as a metric dimension only — never sent to PagerDuty.
   *
   * The two legs have different failure modes and must be separable in one
   * counter: `alertmanager` depends on Prometheus evaluating and Alertmanager
   * delivering, `case` depends on this product's own sweep being alive. Collapsed
   * into one series, a dead sweep is invisible for as long as the fleet alert
   * still fires — which is precisely the window the per-case trigger exists to
   * cover.
   */
  trigger?: 'alertmanager' | 'case';
  /** Required by the API on a `trigger`; ignored on resolve. */
  summary?: string;
  severity?: PagerDutySeverity;
  /** Human-readable origin. Required on a `trigger`. */
  source?: string;
  component?: string;
  /**
   * PagerDuty's grouping dimension. We put the ORG ID here and nothing else —
   * see the note on `customDetails`.
   */
  group?: string;
  class?: string;
  /**
   * Free-form detail. IDS AND TIMESTAMPS ONLY — never case content.
   *
   * This is an authorization boundary, not a style preference. The on-call
   * permission is system-org scoped and grants no tenant access at all
   * (`isSystemOrgId` is a content-owner check, not a privilege gate), so putting
   * a case subject or body here would route tenant content to a third party
   * through a channel that deliberately has no right to read it.
   */
  customDetails?: Record<string, string | number | boolean | null>;
}

export interface PagerDutyResult {
  ok: boolean;
  /** HTTP status when the request completed. */
  status?: number;
  /** Why it failed, for the log line — never surfaced to a tenant. */
  error?: string;
  /** True when paging is configured off, so a caller can tell "off" from "broke". */
  skipped?: boolean;
}

/**
 * Which provider the Events v2 calls go to.
 *
 * `pagerduty` pins the known endpoint. `custom` means "something else that
 * implements this wire format" and REQUIRES `ONCALL_EVENTS_URL` — it does not
 * fall back, because falling back is how a typo'd URL quietly pages the wrong
 * account, or pages nobody while reporting success.
 *
 * WHY THERE IS NO `opsgenie` HERE, although the design notes proposed one:
 * nothing documents Opsgenie accepting the Events v2 shape. Its own alert API
 * takes `message`/`alias`/`priority`, not `summary`/`severity`/`dedup_key`, so
 * an `opsgenie` value would name a provider this client cannot actually talk to
 * — a config option that fails at 3am on the one call that had to work. A
 * genuinely Events-v2-compatible vendor is reachable through `custom` with its
 * endpoint stated, which is honest about who verified the compatibility.
 */
export type OnCallProvider = 'pagerduty' | 'custom';

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

export interface PagerDutyConfig {
  /**
   * Whether paging runs at all. OPT-IN, against this repo's usual opt-out grain
   * (`SUPPORT_ENABLED`, `BILLING_DISCOUNTS_ENABLED`): a feature needing an
   * external credential defaults off here, the way `BILLING_METERING_ENABLED`
   * does, and a pager with no routing key would page nobody while reporting
   * success.
   */
  enabled: boolean;
  /** Per-SERVICE integration key. NOT a REST API key — see docs/oncall-paging.md. */
  routingKey: string;
  provider: OnCallProvider;
  /** Resolved from `provider` + `ONCALL_EVENTS_URL`. Empty means misconfigured. */
  endpoint: string;
  timeoutMs: number;
}

/**
 * Resolve the endpoint from the provider and the override.
 *
 * Exported because the resolution has a failure case worth testing directly:
 * `custom` with no URL returns EMPTY, and the caller treats that as
 * unconfigured rather than silently reaching for PagerDuty's endpoint with
 * somebody else's routing key.
 */
export function resolveEventsEndpoint(provider: OnCallProvider, override: string): string {
  if (override) return override;
  return provider === 'pagerduty' ? PAGERDUTY_EVENTS_URL : '';
}

/**
 * Whether paging is BOTH asked for and coherent.
 *
 * ON-CALL REQUIRES SUPPORT. `ONCALL_ENABLED` exists to page about a support
 * response target, so with `SUPPORT_ENABLED=false` there is no product to page
 * about — the bundles are inactive, no case can be opened, and the only thing
 * left is a deployment paying per seat for a pager wired to nothing.
 *
 * VALIDATED FOR THE ACTIVE FEATURE ONLY, which is the precedent that matters
 * here: a bundle validator once crashed billing at boot by checking every
 * bundle rather than every ACTIVE one. So this neither throws nor warns when
 * paging is off — it is not a conflict until somebody asks for the thing. When
 * they do, the prerequisite is reported once and paging stays off rather than
 * half-on, because a pager that fires for a product nobody sells is the same
 * failure as a pager with no key: it reports coverage of nothing.
 */
function onCallCoherentlyEnabled(): boolean {
  if (!envBool('ONCALL_ENABLED', false)) return false;
  if (envBool('SUPPORT_ENABLED', true)) return true;
  logger.error('ONCALL_ENABLED=true with SUPPORT_ENABLED=false — paging stays OFF', {
    why: 'on-call pages about a support response target; with support off there are no cases and no target',
  });
  return false;
}

export function pagerDutyConfig(): PagerDutyConfig {
  const provider = envStr('ONCALL_PROVIDER', 'pagerduty') === 'custom' ? 'custom' : 'pagerduty';
  return {
    enabled: onCallCoherentlyEnabled(),
    // Read from the environment rather than a mounted file: unlike the
    // Alertmanager Slack URLs (api_url_file), this key is consumed by OUR
    // process, which already receives its secrets as env from a Secret.
    routingKey: envStr('PAGERDUTY_ROUTING_KEY', ''),
    provider,
    endpoint: resolveEventsEndpoint(provider, envStr('ONCALL_EVENTS_URL', '')),
    timeoutMs: envInt('ONCALL_EVENTS_TIMEOUT_MS', 5000, { min: 1 }),
  };
}

/**
 * Send one event. Returns `{ ok: true }` only when PagerDuty ACCEPTED it.
 *
 * A 202 is an acceptance and not a delivery receipt — it says PagerDuty has the
 * event, nothing about whether a phone rang. `oncall_pages_total{outcome}`
 * records what we know, which is this and no more; the only honest evidence of
 * coverage is a human acknowledging.
 */
export async function sendPagerDutyEvent(
  event: PagerDutyEvent,
  cfg: PagerDutyConfig = pagerDutyConfig(),
): Promise<PagerDutyResult> {
  const labels = { action: event.action, trigger: event.trigger ?? 'alertmanager' };

  // Configured OFF is a SKIP, distinct from a failure. The Alertmanager leg
  // relies on this: its route is always present (alertmanager.yml is asserted
  // byte-identical across targets, so it cannot be toggled per deployment), and
  // this endpoint accepting-and-dropping is what makes the knob work without a
  // second config file and without a stream of notification failures.
  if (!cfg.enabled) {
    emitCounter('oncall_pages_total', { ...labels, outcome: 'disabled' });
    return { ok: true, skipped: true };
  }
  if (!cfg.endpoint) {
    // `ONCALL_PROVIDER=custom` with no `ONCALL_EVENTS_URL`. Counted under the
    // same outcome as a missing key because it is the same class of failure —
    // somebody asked for paging and the client has nowhere to send it — and
    // because quietly reaching for PagerDuty's endpoint instead would send this
    // deployment's routing key to a provider nobody chose.
    emitCounter('oncall_pages_total', { ...labels, outcome: 'unconfigured' });
    logger.error('ONCALL_PROVIDER=custom but ONCALL_EVENTS_URL is empty — nobody will be paged', {
      dedupKey: event.dedupKey,
    });
    return { ok: false, error: 'no events endpoint' };
  }
  if (!cfg.routingKey) {
    // Enabled with no key is the half-configured state the knob exists to
    // prevent, and it is the one failure worth shouting about: somebody asked
    // for paging and is not getting it.
    emitCounter('oncall_pages_total', { ...labels, outcome: 'unconfigured' });
    logger.error('ONCALL_ENABLED is true but PAGERDUTY_ROUTING_KEY is empty — nobody will be paged', {
      dedupKey: event.dedupKey,
    });
    return { ok: false, error: 'no routing key' };
  }

  // `resolve` and `acknowledge` need only the key and the action; a trigger
  // needs summary/severity/source. Built conditionally so a resolve cannot be
  // rejected for a missing field it never required.
  const body: Record<string, unknown> = {
    routing_key: cfg.routingKey,
    event_action: event.action,
    dedup_key: event.dedupKey,
  };
  if (event.action === 'trigger') {
    body.payload = {
      summary: event.summary ?? 'Pipeline Builder alert',
      severity: event.severity ?? 'critical',
      source: event.source ?? 'pipeline-builder',
      ...(event.component ? { component: event.component } : {}),
      ...(event.group ? { group: event.group } : {}),
      ...(event.class ? { class: event.class } : {}),
      ...(event.customDetails ? { custom_details: event.customDetails } : {}),
    };
  }

  try {
    const resp = await safeFetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: cfg.timeoutMs,
    });
    // `safeFetch` refuses redirects rather than following them, so a 3xx arrives
    // as `redirected` and is a FAILED send — never a pivot to an unvetted host
    // and never recorded green.
    if (resp.redirected) {
      emitCounter('oncall_pages_total', { ...labels, outcome: 'redirected' });
      logger.error('PagerDuty endpoint redirected — refused', { status: resp.status });
      return { ok: false, status: resp.status, error: 'endpoint redirected (refused)' };
    }
    if (!resp.ok) {
      emitCounter('oncall_pages_total', { ...labels, outcome: 'rejected' });
      logger.error('PagerDuty rejected an event', { status: resp.status, dedupKey: event.dedupKey });
      return { ok: false, status: resp.status, error: `status ${resp.status}` };
    }
    emitCounter('oncall_pages_total', { ...labels, outcome: 'accepted' });
    return { ok: true, status: resp.status };
  } catch (err) {
    emitCounter('oncall_pages_total', { ...labels, outcome: 'error' });
    logger.error('Could not reach PagerDuty', { error: errorMessage(err), dedupKey: event.dedupKey });
    return { ok: false, error: errorMessage(err) };
  }
}

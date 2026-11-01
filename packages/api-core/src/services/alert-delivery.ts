// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a platform-wide alert is meant to GO, as declared configuration.
 *
 * Two destinations, with different jobs. The ops-team Slack channels are the
 * baseline: everything critical or warning lands there and that is where the
 * thread, the context and the handover live. The pager is additive and narrow —
 * only `severity: critical` + `component: support`, because that is the one
 * alert backing a contractual out-of-hours promise.
 *
 * WHAT THIS MODULE CAN AND CANNOT DO, because the limit is not obvious.
 * `config/alertmanager/alertmanager.yml` is in the deploy contract's
 * REQUIRED_IDENTICAL set and asserted byte-identical across targets, and
 * Alertmanager has no templating. So NOTHING here removes a receiver or a route
 * — the routes are always present. What these flags do is:
 *
 *  - declare INTENT, so "we do not use Slack" is a stated decision rather than
 *    something inferred from two empty URLs that look like an oversight;
 *  - gate the deploy-time check (`pb_check_alert_delivery`), which is what turns
 *    a half-configured channel into a refused deploy instead of a 3am surprise;
 *  - drive the posture gauges below, so a dashboard can answer "is anyone
 *    actually going to hear this" without reading four YAML files.
 *
 * The URLS THEMSELVES ARE NOT HERE, and that is deliberate. A Slack webhook URL
 * is a bearer credential: anyone holding it can post to the channel. Alertmanager
 * reads them from a mounted Secret via `api_url_file`, per notification, so they
 * never enter a ConfigMap and never enter this process. Platform knows WHETHER
 * Slack delivery is declared on; it does not know, and does not need, where to.
 * The pager's routing key is different — that one IS consumed by this process, so
 * it lives in `pagerDutyConfig()`.
 */

import { pagerDutyConfig } from './pagerduty.js';
import { envBool, envInt, envStr } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter, emitGauge } from '../utils/metric-emitter.js';
import { safeFetch } from '../utils/ssrf.js';

const logger = createLogger('alert-delivery');

export interface SlackAlertsConfig {
  /**
   * Whether ops-team Slack delivery is DECLARED on.
   *
   * Defaults FALSE, matching `ONCALL_ENABLED`: both destinations are opt-in, so
   * a deployment states what it wants rather than inheriting a channel it may
   * not have. Note what this flag does NOT do — it cannot remove the Slack
   * receivers, because `alertmanager.yml` is asserted byte-identical across
   * targets and Alertmanager has no templating. A deployment with the flag off
   * and real URLs in its Secret still delivers to Slack.
   */
  enabled: boolean;
  /**
   * Whether Slack delivery CAN happen — i.e. the webhook URLs are non-empty.
   *
   * Derived at deploy time (`pb_check_alert_delivery` writes it) because the
   * URLs live in Alertmanager's Secret and never enter this process: a Slack
   * webhook URL is a bearer credential, read per notification via
   * `api_url_file`. Platform therefore cannot inspect them and must be told.
   *
   * SEPARATE FROM `enabled` for the same reason the pager splits the two, and
   * the distinction is what keeps `AlertDeliveryDisabled` honest. Keying that
   * alert on the DECLARATION would page every deployment that left the flag at
   * its default while Slack was quietly working — a false alarm on a healthy
   * system, which is the fastest way to teach people to ignore an alert.
   */
  configured: boolean;
}

export function slackAlertsConfig(): SlackAlertsConfig {
  return {
    enabled: envBool('SLACK_ALERTS_ENABLED', false),
    configured: envBool('SLACK_ALERTS_CONFIGURED', false),
  };
}

/** Both destinations, resolved together — what `reportAlertDeliveryPosture` reads. */
export interface AlertDeliveryConfig {
  slack: SlackAlertsConfig;
  pager: { enabled: boolean; configured: boolean };
}

/** Whether ANY destination could actually deliver — reality, not declaration. */
export function canDeliverAnywhere(cfg: AlertDeliveryConfig): boolean {
  return cfg.slack.configured || (cfg.pager.enabled && cfg.pager.configured);
}

export function alertDeliveryConfig(): AlertDeliveryConfig {
  const pd = pagerDutyConfig();
  return {
    slack: slackAlertsConfig(),
    // `configured` separately from `enabled`: enabled-without-a-key is the
    // half-configured state worth seeing, and it is invisible if the two are
    // collapsed into one boolean.
    pager: { enabled: pd.enabled, configured: pd.routingKey.length > 0 },
  };
}

/**
 * Publish the delivery posture as gauges, and shout if it is incoherent.
 *
 * Called once at boot. Gauges rather than counters because these are STATES of
 * the deployment — an operator wants "will anyone hear an alert right now", not
 * how many times a process started and wondered.
 *
 * The value of having this at all: before it, answering "does this deployment
 * page anyone?" meant reading `.env`, two Secrets and four copies of
 * `alertmanager.yml`. A deployment can now alert on its own inability to alert.
 */
export function reportAlertDeliveryPosture(cfg: AlertDeliveryConfig = alertDeliveryConfig()): void {
  emitGauge('alert_delivery_enabled', { channel: 'slack' }, cfg.slack.enabled ? 1 : 0);
  emitGauge('alert_delivery_enabled', { channel: 'pager' }, cfg.pager.enabled ? 1 : 0);
  emitGauge('alert_delivery_configured', { channel: 'slack' }, cfg.slack.configured ? 1 : 0);
  emitGauge('alert_delivery_configured', { channel: 'pager' }, cfg.pager.configured ? 1 : 0);

  // Enabled with no credential: somebody asked for paging and is not getting it.
  // The deploy check refuses this combination, so reaching here means it was
  // changed after provisioning — which is exactly when nobody is looking.
  if (cfg.pager.enabled && !cfg.pager.configured) {
    logger.error('ONCALL_ENABLED is true but no PAGERDUTY_ROUTING_KEY is set — support criticals will not page');
  }
  // Nothing CAN deliver. Keyed on reachability rather than on the two flags,
  // because the flags are declarations: a deployment that left both at their
  // (false) defaults while real Slack URLs sit in its Secret is delivering
  // fine, and warning it would be a lie.
  if (!canDeliverAnywhere(cfg)) {
    logger.warn('No platform alert destination is enabled — alerts will reach Alertmanager and go no further', {
      hint: 'SLACK_ALERTS_ENABLED / ONCALL_ENABLED',
    });
  }
}

/**
 * The dead-man switch: a heartbeat whose ABSENCE is the alert.
 *
 * Every other alert in this system depends on something inside it still working.
 * This one inverts that — an external service expects a POST on a schedule and
 * raises an incident when one does not arrive, so a platform that is wedged,
 * crashed, partitioned or never started is reported BY ITS SILENCE. Nothing
 * inside a broken deployment has to notice its own brokenness.
 *
 * WHY IT IS BUILT HERE RATHER THAN BOUGHT, when the rest of on-call deliberately
 * is not: PagerDuty's heartbeat monitoring is an Event Orchestration pattern and
 * documented as AIOps-powered, so it may sit behind a tier and is not part of
 * Events v2. More importantly a dead-man switch is a CLOCK, not a telecom
 * problem — the thing that made the last mile worth buying (carrier retries,
 * delivery receipts, a 3am failure budget) simply does not apply to sending one
 * request on an interval. `ONCALL_DEADMAN_URL` therefore points wherever the
 * operator likes: PagerDuty's orchestration endpoint, a purpose-built dead-man
 * service, or an uptime monitor.
 *
 * TWO PROPERTIES WORTH STATING, because they are the reason this is safe:
 *
 *  - It is NOT leader-locked. A heartbeat is per-process on purpose: with three
 *    replicas, the external service hears from whichever are alive, and silence
 *    means ALL of them stopped. Leader-locking it would make the switch report
 *    the leader's health rather than the deployment's — and would make a Redis
 *    outage look identical to a total outage.
 *  - It fails SILENTLY on its own errors, deliberately. A heartbeat that logged
 *    an error every interval during a network blip would be its own noise
 *    source, and the consequence of a missed beat is already handled: the
 *    external service alerts. The only thing it must never do is report success
 *    it did not achieve, which is why nothing here swallows a non-2xx.
 */
export interface DeadmanConfig {
  url: string;
  intervalMs: number;
}

export function deadmanConfig(): DeadmanConfig {
  return {
    url: envStr('ONCALL_DEADMAN_URL', ''),
    intervalMs: envInt('ONCALL_DEADMAN_INTERVAL_MS', 60_000, { min: 1000 }),
  };
}

let deadmanTimer: NodeJS.Timeout | undefined;

/**
 * Start beating. No-op when `ONCALL_DEADMAN_URL` is unset, which is the default:
 * an unconfigured dead-man switch must not beat against nothing, and must not
 * pretend it is covering the deployment.
 *
 * Returns true when a timer was started, so a caller can log the posture.
 */
export function startDeadmanHeartbeat(cfg: DeadmanConfig = deadmanConfig()): boolean {
  if (deadmanTimer || !cfg.url) return false;
  const beat = async (): Promise<void> => {
    try {
      const resp = await safeFetch(cfg.url, { method: 'POST', timeoutMs: 5000, body: '{}', headers: { 'Content-Type': 'application/json' } });
      emitCounter('oncall_deadman_total', { outcome: resp.ok && !resp.redirected ? 'sent' : 'failed' });
    } catch {
      // Counted, never logged per-beat — see the module note on noise.
      emitCounter('oncall_deadman_total', { outcome: 'failed' });
    }
  };
  // `unref` so a pending beat cannot hold the process open during shutdown: the
  // switch exists to report that the process STOPPED, and delaying that is
  // precisely backwards.
  deadmanTimer = setInterval(() => void beat(), cfg.intervalMs);
  deadmanTimer.unref();
  void beat();
  return true;
}

/** Stop beating — called from the unified shutdown path, not a signal handler. */
export function stopDeadmanHeartbeat(): void {
  if (deadmanTimer) clearInterval(deadmanTimer);
  deadmanTimer = undefined;
}

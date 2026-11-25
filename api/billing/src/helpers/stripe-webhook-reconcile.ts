// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the Stripe webhook endpoint subscribed to every event billing handles.
 *
 * The endpoint is created by hand in the Stripe Dashboard. When it is set to
 * "selected events", an event billing handles but the endpoint does not list is
 * never delivered — and nothing anywhere says so: no failed delivery, no log, no
 * retry. A new handler (`charge.dispute.closed`) or a later Dashboard edit that
 * drops one is exactly that case.
 *
 * So the service checks the endpoint itself, at startup and then daily:
 *  - `['*']` already receives everything — nothing to do;
 *  - otherwise the missing handled events are ADDED. Additive on purpose: other
 *    consumers of the same endpoint may rely on events billing does not handle.
 *
 * It never fails startup. When the endpoint cannot be found or updated (a
 * restricted key without webhook-endpoint write permission, a network failure),
 * the missing event names are logged and their count is published as
 * `billing_stripe_webhook_events_missing` (alert: BillingStripeWebhookEventsMissing).
 * When the endpoint could not be read at all, every handled event counts as
 * missing — none of them is confirmed.
 *
 * Leader-locked: one pod writes per cycle. A pod whose cycle is skipped drops its
 * copy of the gauge, so only the current leader's answer is exported.
 */

import { createLogger, createScheduler, errorMessage, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS, type Scheduler } from '@pipeline-builder/api-core';
import { resetGauge, setGauge } from '@pipeline-builder/api-server';
import { config } from '../config.js';
import { getPaymentProvider } from '../providers/provider-factory.js';
import { StripeProvider, type WebhookEndpointView } from '../providers/stripe-provider.js';

const logger = createLogger('stripe-webhook-reconcile');

/** Handled events the endpoint is not confirmed to deliver. 0 = complete. */
export const WEBHOOK_EVENTS_MISSING_METRIC = 'billing_stripe_webhook_events_missing';

/** Re-check cadence: catches a Dashboard edit that drops an event within a day. */
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The provider surface the reconcile needs. */
export type WebhookEndpointClient = Pick<StripeProvider,
  'getKeyMode' | 'listWebhookEndpoints' | 'retrieveWebhookEndpoint' | 'updateWebhookEndpointEvents'>;

export type ReconcileStatus =
  | 'all_events' | 'complete' | 'updated'
  | 'endpoint_not_found' | 'lookup_failed' | 'update_failed';

export interface ReconcileOutcome {
  status: ReconcileStatus;
  endpointId?: string;
  /** Events this run added to the endpoint. */
  added: string[];
  /** Handled events still not confirmed on the endpoint. */
  missing: string[];
}

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '');

/** Find the endpoint: the configured id first, else the one at billing's public webhook URL. */
async function findEndpoint(client: WebhookEndpointClient): Promise<WebhookEndpointView | null> {
  const { webhookEndpointId, webhookUrl } = config.stripe;
  // The key decides the Stripe world; an endpoint from the other one would never
  // deliver to this deployment (and its events would be refused as a mismatch).
  const keyMode = client.getKeyMode();
  const sameWorld = (ep: WebhookEndpointView): boolean => keyMode === null || ep.livemode === (keyMode === 'live');

  if (webhookEndpointId) {
    try {
      const ep = await client.retrieveWebhookEndpoint(webhookEndpointId);
      return sameWorld(ep) ? ep : null;
    } catch (err) {
      if ((err as { code?: string }).code === 'resource_missing') return null;
      throw err;
    }
  }
  if (!webhookUrl) return null;
  const target = normalizeUrl(webhookUrl);
  const endpoints = await client.listWebhookEndpoints();
  return endpoints.find((ep) => sameWorld(ep) && normalizeUrl(ep.url) === target) ?? null;
}

function publish(outcome: ReconcileOutcome): ReconcileOutcome {
  setGauge(WEBHOOK_EVENTS_MISSING_METRIC, {}, outcome.missing.length);
  return outcome;
}

/**
 * One reconcile pass. Never throws: every failure is logged with the missing
 * event names and published through the gauge.
 */
export async function reconcileStripeWebhookEvents(
  client: WebhookEndpointClient,
  handledEvents: readonly string[],
): Promise<ReconcileOutcome> {
  const all = [...handledEvents];
  let endpoint: WebhookEndpointView | null;
  try {
    endpoint = await findEndpoint(client);
  } catch (err) {
    logger.error('Could not read the Stripe webhook endpoint — handled events are unconfirmed', {
      missingEvents: all, error: errorMessage(err),
    });
    return publish({ status: 'lookup_failed', added: [], missing: all });
  }

  if (!endpoint) {
    logger.error('Stripe webhook endpoint not found — handled events may never be delivered', {
      missingEvents: all,
      endpointId: config.stripe.webhookEndpointId || undefined,
      webhookUrl: config.stripe.webhookUrl || undefined,
      fix: 'Create the endpoint, or set STRIPE_WEBHOOK_ENDPOINT_ID to its id (we_…) when it is not registered at PLATFORM_BASE_URL/api/billing/stripe/webhook',
    });
    return publish({ status: 'endpoint_not_found', added: [], missing: all });
  }

  if (endpoint.enabledEvents.includes('*')) {
    return publish({ status: 'all_events', endpointId: endpoint.id, added: [], missing: [] });
  }

  const enabled = new Set(endpoint.enabledEvents);
  const missing = all.filter((e) => !enabled.has(e));
  if (missing.length === 0) {
    return publish({ status: 'complete', endpointId: endpoint.id, added: [], missing: [] });
  }

  try {
    await client.updateWebhookEndpointEvents(endpoint.id, [...endpoint.enabledEvents, ...missing]);
  } catch (err) {
    logger.error('Could not add handled events to the Stripe webhook endpoint — they are not being delivered', {
      endpointId: endpoint.id,
      missingEvents: missing,
      error: errorMessage(err),
      fix: 'Give STRIPE_SECRET_KEY write access to Webhook Endpoints, or add these events to the endpoint in the Stripe Dashboard',
    });
    return publish({ status: 'update_failed', endpointId: endpoint.id, added: [], missing });
  }
  logger.info('Added handled events to the Stripe webhook endpoint', { endpointId: endpoint.id, added: missing });
  return publish({ status: 'updated', endpointId: endpoint.id, added: missing, missing: [] });
}

let scheduler: Scheduler | null = null;

/**
 * Start the reconcile: a pass at startup, then daily. A no-op unless the
 * payment provider is Stripe (the factory has already refused a Stripe
 * provider without a secret key). Never blocks startup — the pass runs in the
 * scheduler's background cycle.
 */
export function startStripeWebhookReconcile(handledEvents: readonly string[]): void {
  if (config.billingProvider !== 'stripe') return;
  if (scheduler) return;
  scheduler = createScheduler({
    name: 'stripe-webhook-reconcile',
    intervalMs: RECONCILE_INTERVAL_MS,
    lock: { key: leaderLockKey('billing', 'stripe-webhook-reconcile'), ttlMs: DEFAULT_LEADER_LOCK_TTL_MS },
    run: async () => {
      const provider = getPaymentProvider();
      if (!(provider instanceof StripeProvider)) return;
      await reconcileStripeWebhookEvents(provider, handledEvents);
    },
    onSkipped: () => { resetGauge(WEBHOOK_EVENTS_MISSING_METRIC); },
  });
  scheduler.start();
}

/** Stop the reconcile (graceful shutdown). Safe when never started. */
export function stopStripeWebhookReconcile(): void {
  scheduler?.stop();
  scheduler = null;
}

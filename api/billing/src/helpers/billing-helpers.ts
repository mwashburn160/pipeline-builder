// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaTier } from '@pipeline-builder/api-core';
import { createLogger, createSafeClient, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { config } from '../config';
import { BillingEvent } from '../models/billing-event';
import type { BillingEventType } from '../models/billing-event';
import type { BillingInterval } from '../models/subscription';

const logger = createLogger('billing-helpers');

// Re-export so callers can keep importing from billing-helpers, but the
// canonical declaration lives with the Mongoose model.
export type { BillingInterval };

/** Resolve the per-request timeout for billing's outbound service calls. */
export function getBillingTimeout(): number {
  const server = Config.get('server') as { services?: { billingTimeout?: number } } | undefined;
  return server?.services?.billingTimeout ?? 5000;
}

/**
 * Calculate the end date for a billing period.
 */
export function calculatePeriodEnd(start: Date, interval: BillingInterval): Date {
  const end = new Date(start);
  if (interval === 'annual') {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

/**
 * Create a billing event for audit logging.
 */
export async function createBillingEvent(
  orgId: string,
  type: BillingEventType,
  details: Record<string, unknown> = {},
  subscriptionId?: string,
): Promise<void> {
  try {
    await BillingEvent.create({ orgId, type, details, subscriptionId });
  } catch (error) {
    logger.error('Failed to create billing event', { orgId, type, error });
    // Surface audit-write failures on a counter so SRE can alert. Don't
    // change error behavior — billing flows continue regardless.
    incCounter('billing_event_write_failed_total', { type });
  }
}

/**
 * Sync organization tier to the quota service after a subscription change.
 *
 * `authHeader` is optional — webhook / lifecycle / SNS paths have no user
 * context and should pass `''`. In that case we mint a service token (which
 * satisfies the quota service's system-admin gate). User-initiated paths
 * (POST /subscriptions, PUT /admin) pass through their bearer.
 *
 * On failure, writes a `billing_events` audit row so support can see that
 * the local DB drifted from the quota service. The audit write itself is
 * best-effort and never throws.
 */
export async function syncTierToQuotaService(
  orgId: string,
  tier: QuotaTier,
  authHeader: string,
  subscriptionId?: string,
): Promise<boolean> {
  try {
    const client = createSafeClient({
      host: config.quotaService.host,
      port: config.quotaService.port,
      timeout: getBillingTimeout(),
    });

    // Mint the service token for the target org so the quota service sees a
    // real tenant identity rather than 'system' — keeps RLS / audit logs
    // attributable to the org being mutated.
    const effectiveAuth = authHeader || getServiceAuthHeader({ serviceName: 'billing', orgId });
    const response = await client.put(`/quotas/${orgId}`, { tier }, {
      headers: {
        'Authorization': effectiveAuth,
        'x-org-id': orgId,
      },
    });

    if (response && response.statusCode < 400) {
      logger.info('Synced tier to quota service', { orgId, tier });
      return true;
    }

    logger.error('Failed to sync tier to quota service', {
      orgId, tier, statusCode: response?.statusCode,
    });
    await createBillingEvent(orgId, 'subscription_updated', {
      reason: 'quota_sync_failed',
      tier,
      statusCode: response?.statusCode,
    }, subscriptionId);
    return false;
  } catch (error) {
    logger.error('Error syncing tier to quota service', { orgId, tier, error });
    await createBillingEvent(orgId, 'subscription_updated', {
      reason: 'quota_sync_failed',
      tier,
      error: error instanceof Error ? error.message : String(error),
    }, subscriptionId);
    return false;
  }
}

/**
 * Build a full subscription response object (used in GET, POST, PUT routes).
 */
export function buildSubscriptionResponse(
  subscription: {
    _id: { toString(): string };
    orgId: string;
    planId: string;
    status: string;
    interval: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  planName?: string,
  tier?: string,
): Record<string, unknown> {
  return {
    id: subscription._id.toString(),
    orgId: subscription.orgId,
    planId: subscription.planId,
    ...(planName !== undefined && { planName }),
    ...(tier !== undefined && { tier }),
    status: subscription.status,
    interval: subscription.interval,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    createdAt: subscription.createdAt.toISOString(),
    updatedAt: subscription.updatedAt.toISOString(),
  };
}

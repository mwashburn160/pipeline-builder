import type { QuotaTier } from '@mwashburn160/api-core';
import { createLogger, createSafeClient } from '@mwashburn160/api-core';
import { config } from '../config';
import { BillingEvent } from '../models/billing-event';
import type { BillingEventType } from '../models/billing-event';

const logger = createLogger('billing-helpers');

/** Billing interval type. */
export type BillingInterval = 'monthly' | 'annual';

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
  }
}

/**
 * Sync organization tier to the quota service after a subscription change.
 */
export async function syncTierToQuotaService(
  orgId: string,
  tier: QuotaTier,
  authHeader: string,
): Promise<boolean> {
  try {
    const client = createSafeClient({
      host: config.quotaService.host,
      port: config.quotaService.port,
      timeout: parseInt(process.env.BILLING_SERVICE_TIMEOUT || '5000', 10),
    });

    const response = await client.put(`/quotas/${orgId}`, { tier }, {
      headers: {
        'Authorization': authHeader,
        'x-org-id': orgId,
      },
    });

    if (response && response.statusCode < 400) {
      logger.info('Synced tier to quota service', { orgId, tier });
      return true;
    }

    logger.warn('Failed to sync tier to quota service', {
      orgId, tier, statusCode: response?.statusCode,
    });
    return false;
  } catch (error) {
    logger.error('Error syncing tier to quota service', { orgId, tier, error });
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

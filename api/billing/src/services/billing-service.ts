// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import {
  buildSubscriptionResponse,
  calculatePeriodEnd,
  createBillingEvent,
  syncTierToQuotaService,
} from '../helpers/billing-helpers';
import { Plan } from '../models/plan';
import { Subscription, type BillingInterval } from '../models/subscription';
import { getPaymentProvider } from '../providers/provider-factory';

const logger = createLogger('billing-service');

/**
 * Service layer for subscription management.
 * Wraps Mongoose operations for subscriptions, keeping route handlers thin.
 */
class BillingService {
  /**
   * Get the active subscription for an organization, including plan details.
   * @returns Formatted subscription response or null if none exists.
   */
  async getSubscription(orgId: string): Promise<Record<string, unknown> | null> {
    const subscription = await Subscription.findOne({ orgId, status: 'active' }).lean();
    if (!subscription) return null;

    const plan = await Plan.findById(subscription.planId).lean();
    return buildSubscriptionResponse(subscription, plan?.name ?? subscription.planId, plan?.tier);
  }

  /**
   * Create a new subscription for an organization.
   * Validates the plan, checks for duplicates, calls the payment provider,
   * and syncs the tier to the quota service.
   *
   * @throws Error with code property for known error conditions
   */
  async createSubscription(
    orgId: string,
    planId: string,
    interval: BillingInterval,
    authHeader: string,
  ): Promise<{ subscription: Record<string, unknown>; status: number }> {
    // Verify plan exists
    const plan = await Plan.findOne({ _id: planId, isActive: true });
    if (!plan) {
      return this.error(404, 'Plan not found', 'NOT_FOUND');
    }

    // Check for existing active subscription
    const existing = await Subscription.findOne({ orgId, status: 'active' });
    if (existing) {
      return this.error(
        409,
        'Organization already has an active subscription. Use PUT to change plans.',
        'DUPLICATE_ENTRY',
      );
    }

    // Call payment provider
    const provider = getPaymentProvider();
    const customerId = await provider.createCustomer(orgId, '');
    const externalResult = await provider.createSubscription(customerId, planId, interval);

    // Create subscription
    const now = new Date();
    const subscription = await Subscription.create({
      orgId,
      planId,
      status: 'active',
      interval,
      currentPeriodStart: now,
      currentPeriodEnd: calculatePeriodEnd(now, interval),
      cancelAtPeriodEnd: false,
      externalId: externalResult.externalId,
      externalCustomerId: externalResult.externalCustomerId,
    });

    // Sync tier to quota service
    await syncTierToQuotaService(orgId, plan.tier, authHeader);

    // Log billing event
    await createBillingEvent(orgId, 'subscription_created', {
      planId, interval, tier: plan.tier,
    }, subscription._id.toString());

    logger.info('Subscription created', { orgId, planId, interval });

    return {
      subscription: buildSubscriptionResponse(subscription, plan.name, plan.tier),
      status: 201,
    };
  }

  /**
   * Update an existing subscription (change plan and/or interval).
   */
  async updateSubscription(
    orgId: string,
    subscriptionId: string,
    updates: { planId?: string; interval?: BillingInterval },
    authHeader: string,
  ): Promise<{ subscription: Record<string, unknown>; status: number }> {
    const { planId, interval } = updates;

    if (!planId && !interval) {
      return this.error(400, 'At least planId or interval is required', 'VALIDATION_ERROR');
    }

    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active',
    });

    if (!subscription) {
      return this.error(404, 'Active subscription not found', 'NOT_FOUND');
    }

    // If changing plan, verify new plan exists
    let plan;
    if (planId && planId !== subscription.planId) {
      plan = await Plan.findOne({ _id: planId, isActive: true });
      if (!plan) {
        return this.error(404, 'Plan not found', 'NOT_FOUND');
      }
      const oldPlanId = subscription.planId;
      subscription.planId = planId;

      await getPaymentProvider().updateSubscription(subscription.externalId || '', planId);

      await createBillingEvent(orgId, 'plan_changed', {
        oldPlanId, newPlanId: planId,
      }, subscriptionId);
    }

    // If changing interval
    if (interval && interval !== subscription.interval) {
      const oldInterval = subscription.interval;
      subscription.interval = interval;
      subscription.currentPeriodEnd = calculatePeriodEnd(
        subscription.currentPeriodStart, interval,
      );

      await createBillingEvent(orgId, 'interval_changed', {
        oldInterval, newInterval: interval,
      }, subscriptionId);
    }

    await subscription.save();

    // Sync tier if plan changed
    if (plan) {
      await syncTierToQuotaService(orgId, plan.tier, authHeader);
    }

    logger.info('Subscription updated', { orgId, subscriptionId, planId, interval });

    return {
      subscription: buildSubscriptionResponse(subscription),
      status: 200,
    };
  }

  /**
   * Cancel a subscription at the end of the current billing period.
   */
  async cancelSubscription(orgId: string, subscriptionId: string): Promise<{ result: Record<string, unknown>; status: number }> {
    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active',
    });

    if (!subscription) {
      return this.error(404, 'Active subscription not found', 'NOT_FOUND');
    }

    subscription.cancelAtPeriodEnd = true;
    await subscription.save();

    await getPaymentProvider().cancelSubscription(subscription.externalId || '');

    await createBillingEvent(orgId, 'subscription_canceled', {
      planId: subscription.planId,
      cancelAtPeriodEnd: true,
      periodEnd: subscription.currentPeriodEnd.toISOString(),
    }, subscriptionId);

    logger.info('Subscription marked for cancellation', { orgId, subscriptionId });

    return {
      result: {
        message: 'Subscription will be canceled at the end of the current billing period.',
        subscription: {
          id: subscription._id.toString(),
          status: subscription.status,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
        },
      },
      status: 200,
    };
  }

  /**
   * Reactivate a subscription that was marked for cancellation.
   */
  async reactivateSubscription(orgId: string, subscriptionId: string): Promise<{ result: Record<string, unknown>; status: number }> {
    const subscription = await Subscription.findOne({
      _id: subscriptionId, orgId, status: 'active', cancelAtPeriodEnd: true,
    });

    if (!subscription) {
      return this.error(404, 'No canceled subscription found to reactivate', 'NOT_FOUND');
    }

    subscription.cancelAtPeriodEnd = false;
    await subscription.save();

    await getPaymentProvider().reactivateSubscription(subscription.externalId || '');

    await createBillingEvent(orgId, 'subscription_reactivated', {
      planId: subscription.planId,
    }, subscriptionId);

    logger.info('Subscription reactivated', { orgId, subscriptionId });

    return {
      result: {
        message: 'Subscription has been reactivated.',
        subscription: {
          id: subscription._id.toString(),
          status: subscription.status,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
        },
      },
      status: 200,
    };
  }

  /** Helper to build a structured error return. */
  private error(status: number, message: string, code: string): never {
    const err = new Error(message) as Error & { status: number; code: string };
    err.status = status;
    err.code = code;
    throw err;
  }
}

export const billingService = new BillingService();

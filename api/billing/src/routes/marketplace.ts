// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  requirePermission,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
} from '@pipeline-builder/api-core';
import { incCounter, withRoute } from '@pipeline-builder/api-server';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { config } from '../config.js';
import {
  applyPlanTierChange,
  applyTierIncludedAddonPrune,
  calculatePeriodEnd,
  createBillingEvent,
  syncEntitlements,
} from '../helpers/billing-helpers.js';
import {
  verifySNSSignature,
  confirmSNSSubscription,
  mapActionToStatus,
  type SNSMessage,
  type MarketplaceNotification,
} from '../helpers/marketplace-helpers.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import type { BillingInterval } from '../models/subscription.js';
import { claimWebhookEvent, releaseWebhookEvent } from '../models/webhook-dedupe.js';
import { AWSMarketplaceProvider, type EntitlementResult } from '../providers/aws-marketplace-provider.js';
import { getPaymentProvider } from '../providers/provider-factory.js';

const logger = createLogger('billing-marketplace');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * A resolved entitlement whose remaining term exceeds this horizon is treated as
 * an ANNUAL contract, otherwise monthly. At resolve time (immediately after the
 * customer subscribes) the entitlement's remaining term ≈ the full contract
 * term, so an annual offer's expiration is ~1 year out and a monthly offer's is
 * ~1 month out — well separated by a ~6-month threshold.
 */
const ANNUAL_TERM_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Derive the billing interval for a marketplace subscription from the resolved
 * entitlement. AWS Marketplace SaaS does NOT expose a first-class billing-cadence
 * field in ResolveCustomer / GetEntitlements, so we infer it from the
 * entitlement's `ExpirationDate` horizon (see {@link ANNUAL_TERM_THRESHOLD_MS}):
 * a term more than ~6 months out is annual, otherwise monthly. When the
 * entitlement carries no expiration we can't tell — default to `'monthly'`.
 *
 * TODO(marketplace): if the product listing later exposes a dedicated
 * billing-term dimension (or ResolveCustomer surfaces the offer cadence), map
 * that authoritative value here instead of inferring from the expiration horizon.
 */
function deriveMarketplaceInterval(entitlement: EntitlementResult | undefined, now: Date): BillingInterval {
  const exp = entitlement?.expirationDate;
  if (!exp) return 'monthly';
  return exp.getTime() - now.getTime() > ANNUAL_TERM_THRESHOLD_MS ? 'annual' : 'monthly';
}

// Helpers

/**
 * Return the active payment provider if it is an AWS Marketplace provider.
 * @returns The marketplace provider instance, or null if a different provider is active
 */
function getMarketplaceProvider(): AWSMarketplaceProvider | null {
  const provider = getPaymentProvider();
  return provider instanceof AWSMarketplaceProvider ? provider : null;
}

/**
 * Process a parsed marketplace notification.
 * Handles entitlement updates, cancellations, reactivations, and other status changes.
 * @param notification - Parsed marketplace notification payload from SNS
 */
async function processMarketplaceNotification(notification: MarketplaceNotification): Promise<void> {
  const {
    action,
    'customer-identifier': customerIdentifier,
    'product-code': productCode,
  } = notification;

  logger.info('Processing marketplace notification', { action, customerIdentifier, productCode });

  // Entitlement update — re-check entitlements and update plan
  if (action === 'entitlement-updated') {
    await handleEntitlementUpdate(customerIdentifier);
    return;
  }

  // Map action to subscription status change
  const statusChange = mapActionToStatus(action);
  if (!statusChange) {
    logger.warn('Unknown marketplace notification action', { action });
    return;
  }

  // cancel→resubscribe can leave a canceled row + a new active row sharing the
  // identifier (the unique index is partial on active rows). Take the NEWEST so
  // the notification lands on the current subscription, not a stale canceled one.
  const subscription = await Subscription.findOne({
    'metadata.awsCustomerIdentifier': customerIdentifier,
  }).sort({ createdAt: -1 });

  if (!subscription) {
    logger.warn('No subscription found for marketplace customer', { customerIdentifier });
    return;
  }

  const previousStatus = subscription.status;
  subscription.status = statusChange.status;
  subscription.cancelAtPeriodEnd = statusChange.cancelAtPeriodEnd;
  await subscription.save();

  // These billing events originate from AWS Marketplace SNS notifications, not
  // a request user — actorId is intentionally left undefined (no fabricated
  // actor for system-driven events).
  // Determine event type and sync tier.
  // For an immediate cancel ('canceled') we downgrade now. For a soft cancel
  // ('cancelAtPeriodEnd') the org has paid through `currentPeriodEnd` —
  // downgrading now would strip their tier mid-period. The lifecycle cron
  // (api/billing/src/helpers/subscription-lifecycle.ts) handles the actual
  // downgrade once `currentPeriodEnd` lapses.
  if (statusChange.status === 'canceled') {
    await syncEntitlements(subscription.orgId, 'developer', '', subscription._id.toString());
    await createBillingEvent(subscription.orgId, 'subscription_canceled', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
    }, subscription._id.toString());
  } else if (statusChange.cancelAtPeriodEnd) {
    await createBillingEvent(subscription.orgId, 'subscription_canceled', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
      pendingDowngradeAt: subscription.currentPeriodEnd,
    }, subscription._id.toString());
  } else if (previousStatus === 'canceled' && statusChange.status === 'active') {
    const plan = await Plan.findById(subscription.planId);
    if (plan) {
      await syncEntitlements(subscription.orgId, plan.tier, '', subscription._id.toString(), subscription.addons ?? []);
    } else {
      // planId points at a deleted/missing plan: the sub reactivates into an
      // entitled status but we can't resolve a tier to re-grant — the sync
      // silently no-ops. Surface it (WARN + audit row + metric) so support can
      // repair the dangling planId. The subscription_reactivated row below still
      // records the reactivation; this adds the plan-missing signal.
      logger.warn('Marketplace reactivation could not sync — subscription plan not found', {
        orgId: subscription.orgId, customerIdentifier, planId: subscription.planId,
      });
      await createBillingEvent(subscription.orgId, 'subscription_updated', {
        reason: 'reactivate_plan_missing', provider: 'aws-marketplace', planId: subscription.planId,
      }, subscription._id.toString());
      incCounter('billing_reactivate_plan_missing_total', { source: 'marketplace' });
    }
    await createBillingEvent(subscription.orgId, 'subscription_reactivated', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
    }, subscription._id.toString());
  } else {
    await createBillingEvent(subscription.orgId, 'subscription_updated', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
    }, subscription._id.toString());
  }

  logger.info('Marketplace notification processed', {
    action,
    customerIdentifier,
    orgId: subscription.orgId,
    previousStatus,
    newStatus: statusChange.status,
  });
}

/**
 * Handle an entitlement-updated notification.
 * Re-checks entitlements via the Marketplace API and upgrades/downgrades the plan.
 * @param customerIdentifier - AWS Marketplace customer identifier
 */
async function handleEntitlementUpdate(customerIdentifier: string): Promise<void> {
  const provider = getMarketplaceProvider();
  if (!provider) return;

  const subscription = await Subscription.findOne({
    'metadata.awsCustomerIdentifier': customerIdentifier,
    'status': 'active',
  });

  if (!subscription) {
    logger.warn('No active subscription for entitlement update', { customerIdentifier });
    return;
  }

  const entitlements = await provider.getEntitlements(customerIdentifier);
  const activeEntitlement = entitlements.find((e) => e.isEntitled);
  const newPlanId = activeEntitlement?.planId || 'developer';

  // Re-derive the billing cadence from the (possibly new) entitlement term. AWS
  // does not surface cadence directly, so a monthly↔annual MOVE only shows up as a
  // changed ExpirationDate horizon (see deriveMarketplaceInterval). Without this
  // the interval stays stale after such a move and every downstream period key
  // (periodKeyFor / periodBounds) + interval-priced credit (priceForInterval)
  // mis-keys against the old cadence.
  //
  // BUT the horizon SHRINKS as a term ages: an annual sub sitting in the back half
  // of its term has `exp - now < 180d`, so deriveMarketplaceInterval would read
  // 'monthly' and — on this UPDATE path — flip the sub to monthly, reset the period,
  // and mis-price credits purely because time passed. AWS exposes no authoritative
  // cadence field to disambiguate, so we only ADOPT a horizon-derived interval when
  // it LENGTHENS the term (monthly→annual). An existing annual interval is never
  // shortened from the horizon alone; a genuine annual→monthly downgrade arrives as
  // a plan/dimension change and re-cadences through the plan-change path below.
  const now = new Date();
  const derivedInterval = deriveMarketplaceInterval(activeEntitlement, now);
  const newInterval: BillingInterval =
    subscription.interval === 'monthly' && derivedInterval === 'annual'
      ? 'annual'
      : subscription.interval;
  const intervalChanged = newInterval !== subscription.interval;

  // Nothing to do only when BOTH the plan AND the cadence are unchanged — an
  // interval-only move (same plan, monthly→annual) must still re-cadence.
  if (newPlanId === subscription.planId && !intervalChanged) {
    logger.debug('Entitlement unchanged', { customerIdentifier, planId: newPlanId, interval: newInterval });
    return;
  }

  // An interval-only move (same plan) still needs the period re-cadenced +
  // interval_changed recorded, but there is no tier/entitlement change to sync.
  if (newPlanId === subscription.planId && intervalChanged) {
    const oldInterval = subscription.interval;
    subscription.interval = newInterval;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = calculatePeriodEnd(now, newInterval);
    await subscription.save();
    await createBillingEvent(subscription.orgId, 'interval_changed', {
      provider: 'aws-marketplace', customerIdentifier, oldInterval, newInterval,
    }, subscription._id.toString());
    logger.info('Marketplace interval re-cadenced from entitlement change', {
      customerIdentifier, orgId: subscription.orgId, oldInterval, newInterval,
    });
    return;
  }

  const plan = await Plan.findOne({ _id: newPlanId, isActive: true });
  if (!plan) {
    logger.error('Entitlement maps to unknown plan', { newPlanId });
    return;
  }

  const oldPlanId = subscription.planId;
  const oldInterval = subscription.interval;
  subscription.planId = newPlanId;
  // Re-cadence alongside the plan change so credit-period math tracks the current
  // term — mirrors the resolve path (which sets interval + period from the same
  // entitlement). A no-op when the cadence is unchanged.
  if (intervalChanged) {
    subscription.interval = newInterval;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = calculatePeriodEnd(now, newInterval);
  }

  // Prune any PURE-FEATURE add-on the new tier now bundles in (double-billing
  // fix) so a marketplace tier upgrade also drops the redundant paid bundle.
  // Mutates the doc's addons in memory (persisted by save below); hybrid bundles
  // that also grant a quota (e.g. `sso`→idpConfigs) are kept.
  const subscriptionId = subscription._id.toString();
  const pruned = applyTierIncludedAddonPrune(subscription, plan.tier, {
    orgId: subscription.orgId, subscriptionId, source: 'marketplace_plan_change',
  });

  // Shared post-save runner: entitlement sync (preserving add-ons) → plan_changed
  // row → addon_pruned trail. `authHeader: ''` threads through to syncEntitlements
  // (which mints its own service token — no user context on the SNS path). System
  // path → no actorId. Marketplace add-ons are AWS-metered, so the provider
  // line-item removal inside finalizePrunedAddons is a no-op (local event + audit
  // still recorded so finance can reconcile).
  const runSideEffects = applyPlanTierChange(subscription, plan, {
    oldPlanId,
    newPlanId,
    pruned,
    authHeader: '',
    source: 'marketplace_plan_change',
    eventDetails: { provider: 'aws-marketplace', customerIdentifier, dimension: activeEntitlement?.dimension, interval: subscription.interval },
  });

  await subscription.save();
  await runSideEffects();

  // A plan change that ALSO moved the cadence records a distinct interval_changed
  // row (the plan_changed row above only carries the interval as a detail) so the
  // move is visible in the billing timeline.
  if (intervalChanged) {
    await createBillingEvent(subscription.orgId, 'interval_changed', {
      provider: 'aws-marketplace', customerIdentifier, oldInterval, newInterval,
    }, subscriptionId);
  }

  logger.info('Plan updated from entitlement change', {
    customerIdentifier,
    oldPlanId,
    newPlanId,
    orgId: subscription.orgId,
    interval: subscription.interval,
    intervalChanged,
  });
}

// Route factory

/**
 * Create the AWS Marketplace integration router.
 *
 * Registers:
 * - POST /marketplace/resolve      -- exchange a registration token for a subscription
 * - POST /marketplace/sns          -- receive SNS webhook notifications
 * - GET  /marketplace/entitlements -- check current entitlements (authenticated)
 * @returns Express Router
 */
export function createMarketplaceRoutes(): Router {
  const router: Router = Router();

  // POST /billing/marketplace/resolve — Registration redirect endpoint
  // No auth — this is called by AWS Marketplace redirect flow

  router.post(
    '/marketplace/resolve',
    async (req: Request, res: Response) => {
      const token = req.body?.['x-amzn-marketplace-token']
        || req.body?.token
        || (req.query?.token as string | undefined);

      if (!token) {
        return sendError(
          res, 400,
          'Marketplace registration token is required',
          ErrorCode.MISSING_REQUIRED_FIELD,
        );
      }

      try {
        const provider = getMarketplaceProvider();
        if (!provider) {
          return sendError(
            res, 400,
            'AWS Marketplace provider is not configured',
            ErrorCode.VALIDATION_ERROR,
          );
        }

        // Step 1: Resolve the token
        const resolved = await provider.resolveRegistrationToken(token);
        logger.info('Resolved marketplace customer', {
          customerIdentifier: resolved.customerIdentifier,
        });

        // Step 2: Check for existing subscription
        const existing = await Subscription.findOne({
          'metadata.awsCustomerIdentifier': resolved.customerIdentifier,
          'status': 'active',
        });

        if (existing) {
          return sendSuccess(res, 200, {
            message: 'Customer already registered',
            subscription: {
              id: existing._id.toString(),
              orgId: existing.orgId,
              planId: existing.planId,
              status: existing.status,
            },
            customerIdentifier: resolved.customerIdentifier,
          });
        }

        // Step 3: Get entitlements to determine tier
        const entitlements = await provider.getEntitlements(resolved.customerIdentifier);
        const activeEntitlement = entitlements.find((e) => e.isEntitled);
        const planId = activeEntitlement?.planId || 'developer';

        // Step 4: Verify the plan exists
        const plan = await Plan.findOne({ _id: planId, isActive: true });
        if (!plan) {
          logger.error('Marketplace entitlement maps to unknown plan', { planId, entitlements });
          return sendError(
            res, 500,
            'Unable to map marketplace entitlement to a valid plan',
            ErrorCode.INTERNAL_ERROR,
          );
        }

        // Step 5: Create the subscription. This route is unauthenticated
        // (AWS-redirected), so the orgId MUST come from the AWS-resolved
        // customer — accepting a body-supplied orgId would let any caller
        // bind a marketplace subscription to an arbitrary org.
        if (req.body?.orgId) {
          return sendError(
            res, 400,
            'orgId is not accepted on this endpoint',
            ErrorCode.VALIDATION_ERROR,
          );
        }
        // Key the org on AWS Marketplace's opaque `customerIdentifier` token
        // (also our subscription lookup key), NOT `customerAWSAccountId` — repo
        // policy forbids persisting AWS account ids, and the account id would
        // otherwise propagate into quota/audit stores as the tenant key.
        const orgId = resolved.customerIdentifier;
        const now = new Date();

        // Derive the cadence from the entitlement's term rather than assuming
        // monthly — an annual offer must get an annual period so renewal-reminder
        // and period math are correct. Defaults to monthly when AWS gives us no
        // term to key on (see deriveMarketplaceInterval).
        const interval = deriveMarketplaceInterval(activeEntitlement, now);

        const subscription = await Subscription.create({
          orgId,
          planId,
          status: 'active',
          interval,
          currentPeriodStart: now,
          currentPeriodEnd: calculatePeriodEnd(now, interval),
          cancelAtPeriodEnd: false,
          externalId: `aws_sub_${resolved.customerIdentifier}`,
          externalCustomerId: resolved.customerIdentifier,
          metadata: {
            provider: 'aws-marketplace',
            awsCustomerIdentifier: resolved.customerIdentifier,
            awsProductCode: resolved.productCode,
            dimension: activeEntitlement?.dimension,
          },
        });

        // Step 6: Sync tier to quota service (preserve purchased add-on grants)
        await syncEntitlements(orgId, plan.tier, '', subscription._id.toString(), subscription.addons ?? []);

        // Step 7: Log billing event
        await createBillingEvent(orgId, 'subscription_created', {
          planId,
          tier: plan.tier,
          provider: 'aws-marketplace',
          awsCustomerIdentifier: resolved.customerIdentifier,
        }, subscription._id.toString());

        logger.info('Marketplace subscription created', {
          orgId,
          planId,
          customerIdentifier: resolved.customerIdentifier,
        });

        return sendSuccess(res, 201, {
          message: 'Registration successful',
          subscription: {
            id: subscription._id.toString(),
            orgId,
            planId,
            planName: plan.name,
            status: 'active',
          },
          customerIdentifier: resolved.customerIdentifier,
        });
      } catch (error) {
        logger.error('Failed to resolve marketplace token', { error: errorMessage(error) });
        return sendError(
          res, 500,
          'Failed to process marketplace registration',
          ErrorCode.INTERNAL_ERROR,
        );
      }
    },
  );

  // POST /billing/marketplace/sns — SNS notification webhook
  // No auth — SNS uses signature verification instead

  router.post(
    '/marketplace/sns',
    async (req: Request, res: Response) => {
      // Set once we hold the dedup claim; released in catch so a transient
      // processing failure doesn't permanently short-circuit SNS's retries.
      let claimedMessageId: string | undefined;
      try {
        // SNS may send text/plain — parse if needed
        const snsMessage: SNSMessage = typeof req.body === 'string'
          ? JSON.parse(req.body)
          : req.body;

        // Validate required fields
        if (!snsMessage.Type || !snsMessage.MessageId || !snsMessage.Signature) {
          return sendError(res, 400, 'Invalid SNS message format', ErrorCode.VALIDATION_ERROR);
        }

        // Verify SNS signature
        const isValid = await verifySNSSignature(snsMessage);
        if (!isValid) {
          logger.warn('SNS signature verification failed', { messageId: snsMessage.MessageId });
          return sendError(res, 403, 'Invalid SNS signature', ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Verify topic ARN matches config — FAIL CLOSED. If the expected topic
        // is unset, a valid signature from ANY attacker-owned SNS topic would
        // otherwise be accepted (they could publish e.g. unsubscribe-success for
        // a guessable customerIdentifier and downgrade that org). Reject unless a
        // topic is configured AND the message came from exactly that topic.
        if (!config.marketplace.snsTopicArn || snsMessage.TopicArn !== config.marketplace.snsTopicArn) {
          logger.warn('marketplace SNS topic not configured / mismatch — rejecting', {
            expected: config.marketplace.snsTopicArn,
            received: snsMessage.TopicArn,
          });
          return sendError(res, 403, 'Unexpected SNS topic', ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Idempotency guard: SNS retries the same MessageId on transient
        // failures. Claim the ID before processing — duplicate deliveries
        // short-circuit with 200 (so SNS stops retrying) but skip side-effects.
        const isFirstDelivery = await claimWebhookEvent('sns', snsMessage.MessageId);
        if (!isFirstDelivery) {
          logger.info('Skipping duplicate SNS delivery', { messageId: snsMessage.MessageId, type: snsMessage.Type });
          return sendSuccess(res, 200, { message: 'Duplicate message acknowledged' });
        }
        claimedMessageId = snsMessage.MessageId;

        switch (snsMessage.Type) {
          case 'SubscriptionConfirmation': {
            if (snsMessage.SubscribeURL) {
              await confirmSNSSubscription(snsMessage.SubscribeURL);
              logger.info('SNS subscription confirmed', { topicArn: snsMessage.TopicArn });
            }
            return sendSuccess(res, 200, { message: 'Subscription confirmed' });
          }

          case 'UnsubscribeConfirmation': {
            logger.info('SNS unsubscribe confirmation received', { topicArn: snsMessage.TopicArn });
            return sendSuccess(res, 200, { message: 'Unsubscribe acknowledged' });
          }

          case 'Notification': {
            const notification: MarketplaceNotification = JSON.parse(snsMessage.Message);
            await processMarketplaceNotification(notification);
            return sendSuccess(res, 200, { message: 'Notification processed' });
          }

          default:
            logger.warn('Unknown SNS message type', { type: snsMessage.Type });
            return sendSuccess(res, 200, { message: 'Unknown type acknowledged' });
        }
      } catch (error) {
        logger.error('Failed to process SNS notification', { error: errorMessage(error) });
        // Release the idempotency claim so SNS's retry of this MessageId
        // re-processes instead of being short-circuited as a duplicate (which
        // would silently drop the event on a transient failure).
        if (claimedMessageId) await releaseWebhookEvent('sns', claimedMessageId).catch(() => {});
        return sendError(
          res, 500,
          'Failed to process notification',
          ErrorCode.INTERNAL_ERROR,
        );
      }
    },
  );

  // GET /billing/marketplace/entitlements — Check current entitlements

  router.get(
    '/marketplace/entitlements',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requirePermission('billing:read') as RequestHandler,
    withRoute(async ({ res, ctx, orgId }) => {
      const provider = getMarketplaceProvider();
      if (!provider) {
        return sendError(
          res, 400,
          'AWS Marketplace provider is not configured',
          ErrorCode.VALIDATION_ERROR,
        );
      }

      const subscription = await Subscription.findOne({
        orgId,
        'metadata.provider': 'aws-marketplace',
      });

      if (!subscription || !subscription.metadata?.awsCustomerIdentifier) {
        return sendError(
          res, 404,
          'No marketplace subscription found for this organization',
          ErrorCode.NOT_FOUND,
        );
      }

      const customerIdentifier = subscription.metadata.awsCustomerIdentifier as string;
      const entitlements = await provider.getEntitlements(customerIdentifier);

      ctx.log('COMPLETED', 'Retrieved marketplace entitlements', { orgId, customerIdentifier });
      return sendSuccess(res, 200, {
        customerIdentifier,
        entitlements,
        currentPlanId: subscription.planId,
      });
    }),
  );

  return router;
}

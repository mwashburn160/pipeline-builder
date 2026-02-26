/**
 * @module routes/marketplace
 * @description AWS Marketplace SaaS integration routes.
 *
 * POST /billing/marketplace/resolve      — Registration redirect (exchange token)
 * POST /billing/marketplace/sns          — SNS notification webhook
 * GET  /billing/marketplace/entitlements — Check current entitlements
 */

import {
  authenticateToken,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
} from '@mwashburn160/api-core';
import { Router, Request, Response, RequestHandler } from 'express';
import { config } from '../config';
import {
  calculatePeriodEnd,
  createBillingEvent,
  syncTierToQuotaService,
} from '../helpers/billing-helpers';
import {
  verifySNSSignature,
  confirmSNSSubscription,
  mapActionToStatus,
  type SNSMessage,
  type MarketplaceNotification,
} from '../helpers/marketplace-helpers';
import { Plan } from '../models/plan';
import { Subscription } from '../models/subscription';
import { AWSMarketplaceProvider } from '../providers/aws-marketplace-provider';
import { getPaymentProvider } from '../providers/provider-factory';

const logger = createLogger('billing-marketplace');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  const subscription = await Subscription.findOne({
    'metadata.awsCustomerIdentifier': customerIdentifier,
  });

  if (!subscription) {
    logger.warn('No subscription found for marketplace customer', { customerIdentifier });
    return;
  }

  const previousStatus = subscription.status;
  subscription.status = statusChange.status;
  subscription.cancelAtPeriodEnd = statusChange.cancelAtPeriodEnd;
  await subscription.save();

  // Determine event type and sync tier
  if (statusChange.status === 'canceled' || statusChange.cancelAtPeriodEnd) {
    await syncTierToQuotaService(subscription.orgId, 'developer', '');
    await createBillingEvent(subscription.orgId, 'subscription_canceled', {
      action,
      provider: 'aws-marketplace',
      previousStatus,
      newStatus: statusChange.status,
      customerIdentifier,
    }, subscription._id.toString());
  } else if (previousStatus === 'canceled' && statusChange.status === 'active') {
    const plan = await Plan.findById(subscription.planId);
    if (plan) {
      await syncTierToQuotaService(subscription.orgId, plan.tier, '');
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

  if (newPlanId === subscription.planId) {
    logger.debug('Entitlement unchanged', { customerIdentifier, planId: newPlanId });
    return;
  }

  const plan = await Plan.findOne({ _id: newPlanId, isActive: true });
  if (!plan) {
    logger.error('Entitlement maps to unknown plan', { newPlanId });
    return;
  }

  const oldPlanId = subscription.planId;
  subscription.planId = newPlanId;
  await subscription.save();

  await syncTierToQuotaService(subscription.orgId, plan.tier, '');

  await createBillingEvent(subscription.orgId, 'plan_changed', {
    oldPlanId,
    newPlanId,
    provider: 'aws-marketplace',
    customerIdentifier,
    dimension: activeEntitlement?.dimension,
  }, subscription._id.toString());

  logger.info('Plan updated from entitlement change', {
    customerIdentifier,
    oldPlanId,
    newPlanId,
    orgId: subscription.orgId,
  });
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // POST /billing/marketplace/resolve — Registration redirect endpoint
  // ---------------------------------------------------------------------------

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
          awsAccountId: resolved.customerAWSAccountId,
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
            awsAccountId: resolved.customerAWSAccountId,
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

        // Step 5: Create the subscription
        const orgId = req.body?.orgId || resolved.customerAWSAccountId;
        const now = new Date();

        const subscription = await Subscription.create({
          orgId,
          planId,
          status: 'active',
          interval: 'monthly',
          currentPeriodStart: now,
          currentPeriodEnd: calculatePeriodEnd(now, 'monthly'),
          cancelAtPeriodEnd: false,
          externalId: `aws_sub_${resolved.customerIdentifier}`,
          externalCustomerId: resolved.customerIdentifier,
          metadata: {
            provider: 'aws-marketplace',
            awsCustomerIdentifier: resolved.customerIdentifier,
            awsAccountId: resolved.customerAWSAccountId,
            awsProductCode: resolved.productCode,
            dimension: activeEntitlement?.dimension,
          },
        });

        // Step 6: Sync tier to quota service
        await syncTierToQuotaService(orgId, plan.tier, '');

        // Step 7: Log billing event
        await createBillingEvent(orgId, 'subscription_created', {
          planId,
          tier: plan.tier,
          provider: 'aws-marketplace',
          awsCustomerIdentifier: resolved.customerIdentifier,
          awsAccountId: resolved.customerAWSAccountId,
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
          awsAccountId: resolved.customerAWSAccountId,
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

  // ---------------------------------------------------------------------------
  // POST /billing/marketplace/sns — SNS notification webhook
  // ---------------------------------------------------------------------------

  router.post(
    '/marketplace/sns',
    async (req: Request, res: Response) => {
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

        // Verify topic ARN matches config (if configured)
        if (config.marketplace.snsTopicArn && snsMessage.TopicArn !== config.marketplace.snsTopicArn) {
          logger.warn('SNS message from unexpected topic', {
            expected: config.marketplace.snsTopicArn,
            received: snsMessage.TopicArn,
          });
          return sendError(res, 403, 'Unexpected SNS topic', ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

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
        return sendError(
          res, 500,
          'Failed to process notification',
          ErrorCode.INTERNAL_ERROR,
        );
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /billing/marketplace/entitlements — Check current entitlements
  // ---------------------------------------------------------------------------

  router.get(
    '/marketplace/entitlements',
    authenticateToken(AUTH_OPTS) as RequestHandler,
    async (req: Request, res: Response) => {
      const orgId = req.user?.organizationId;
      if (!orgId) {
        return sendError(res, 400, 'Organization ID is required', ErrorCode.MISSING_REQUIRED_FIELD);
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

        return sendSuccess(res, 200, {
          customerIdentifier,
          entitlements,
          currentPlanId: subscription.planId,
        });
      } catch (error) {
        logger.error('Failed to get marketplace entitlements', { error: errorMessage(error), orgId });
        return sendError(res, 500, 'Failed to get entitlements', ErrorCode.INTERNAL_ERROR);
      }
    },
  );

  return router;
}

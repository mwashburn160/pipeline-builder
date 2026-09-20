// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import {
  audited,
  requireAuth,
  requireOrgAdminAssurance,
  requirePermission,
  sendSuccess,
  sendError,
  ErrorCode,
  createLogger,
  errorMessage,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { config } from '../config.js';
import { calculatePeriodEnd, createBillingEvent, syncEntitlements } from '../helpers/billing-helpers.js';
import {
  verifySNSSignature,
  confirmSNSSubscription,
  type SNSMessage,
  type MarketplaceNotification,
} from '../helpers/marketplace-helpers.js';
import {
  deriveMarketplaceInterval,
  getMarketplaceProvider,
  processMarketplaceNotification,
} from '../helpers/marketplace-notifications.js';
import { MarketplacePendingRegistration, PENDING_REGISTRATION_TTL_MS } from '../models/marketplace-pending-registration.js';
import { Plan } from '../models/plan.js';
import { Subscription } from '../models/subscription.js';
import { claimWebhookEvent, markWebhookEventDone, releaseWebhookEvent } from '../models/webhook-dedupe.js';
import { getAuditClient } from '../services/audit.js';

const logger = createLogger('billing-marketplace');

const AUTH_OPTS = { allowOrgHeaderOverride: true } as const;

/**
 * Create the AWS Marketplace integration router.
 *
 * Registers:
 * - POST /marketplace/resolve      -- exchange a registration token for a pending registration (unauthenticated, AWS redirect)
 * - POST /marketplace/claim        -- bind a pending registration to the caller's org (authenticated)
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

        // A body-supplied orgId is never honored here: this route is
        // unauthenticated (AWS-redirected) and binding happens later in `claim`
        // under the caller's authenticated org — accepting an orgId would let
        // anyone pre-bind a marketplace subscription to an arbitrary org.
        if (req.body?.orgId) {
          return sendError(
            res, 400,
            'orgId is not accepted on this endpoint',
            ErrorCode.VALIDATION_ERROR,
          );
        }

        // Step 2: Already bound? If a real org has already claimed this AWS
        // customer, there's nothing to register — tell the caller to sign in.
        const existing = await Subscription.findOne({
          'metadata.awsCustomerIdentifier': resolved.customerIdentifier,
          'status': 'active',
        });

        if (existing) {
          return sendSuccess(res, 200, {
            alreadyRegistered: true,
            planId: existing.planId,
            message: 'This AWS Marketplace subscription is already linked to an organization. Sign in to manage it.',
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

        // Step 5: Bank a short-lived, single-use pending registration instead of
        // creating a subscription now — there is no platform org to bind it to
        // until the purchaser signs in and calls `claim`. Cadence is derived from
        // the entitlement term (see deriveMarketplaceInterval).
        const interval = deriveMarketplaceInterval(activeEntitlement, new Date());
        // Bound row growth + supersede any prior unclaimed resolve for this
        // customer: a repeated resolve (e.g. the purchaser re-clicks "Set up your
        // account") invalidates the older ref rather than accumulating rows. TTL
        // still cleans truly-abandoned ones.
        await MarketplacePendingRegistration.deleteMany({ awsCustomerIdentifier: resolved.customerIdentifier });
        const registrationRef = randomUUID();
        await MarketplacePendingRegistration.create({
          _id: registrationRef,
          awsCustomerIdentifier: resolved.customerIdentifier,
          awsProductCode: resolved.productCode,
          planId,
          dimension: activeEntitlement?.dimension,
          interval,
          expiresAt: new Date(Date.now() + PENDING_REGISTRATION_TTL_MS),
        });

        logger.info('Marketplace registration resolved (pending claim)', {
          registrationRef,
          planId,
          customerIdentifier: resolved.customerIdentifier,
        });

        // NOTE: the customerIdentifier is deliberately NOT returned — the opaque
        // registrationRef is the only handle the client needs, and it keeps the
        // AWS identity off the browser. Bind with POST /billing/marketplace/claim.
        return sendSuccess(res, 201, {
          alreadyRegistered: false,
          registrationRef,
          planId,
          planName: plan.name,
          interval,
          expiresInMs: PENDING_REGISTRATION_TTL_MS,
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

  // POST /billing/marketplace/claim — bind a resolved registration to the
  // caller's organization. Authenticated: the AWS purchaser signs in / signs up
  // first, THEN links the marketplace subscription to their real org.

  router.post(
    '/marketplace/claim',
    requireAuth(AUTH_OPTS) as RequestHandler,
    requirePermission('billing:manage') as RequestHandler,
    // Binding a subscription to the org is an administrative action under the
    // org's "administrative actions require MFA" policy (machines pass).
    requireOrgAdminAssurance({ machines: 'allow' }) as RequestHandler,
    audited('billing.subscription.create'),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const registrationRef = (req.body as { registrationRef?: unknown })?.registrationRef;
      if (typeof registrationRef !== 'string' || !registrationRef) {
        return sendError(res, 400, 'registrationRef is required', ErrorCode.MISSING_REQUIRED_FIELD);
      }

      // Atomically CONSUME the pending registration up front: findOneAndDelete
      // guarantees single-use even under concurrent/duplicate claims — exactly
      // one racer receives the doc, the rest see null → 410. The
      // `metadata.awsCustomerIdentifier` index is NOT unique, so this atomic
      // consume (not the DB) is what stops two different orgs binding the same AWS
      // customer through a shared ref. Missing/expired ⇒ the resolve window lapsed
      // or it was already claimed — re-launch from AWS Marketplace for a fresh token.
      const pending = await MarketplacePendingRegistration.findOneAndDelete({ _id: registrationRef });
      if (!pending) {
        return sendError(res, 410, 'Registration link expired or already used — re-launch from AWS Marketplace', ErrorCode.NOT_FOUND);
      }

      // Guard: this AWS customer must not already be bound (e.g. a prior claim on
      // a different ref). Best-effort pre-check; the create below is also wrapped.
      const alreadyBound = await Subscription.findOne({
        'metadata.awsCustomerIdentifier': pending.awsCustomerIdentifier,
        'status': 'active',
      });
      if (alreadyBound) {
        return sendError(res, 409, 'This AWS Marketplace subscription is already linked to an organization', ErrorCode.CONFLICT);
      }

      // Guard: the caller's org must not already hold an active subscription.
      const orgActive = await Subscription.findOne({ orgId, status: 'active' });
      if (orgActive) {
        return sendError(res, 409, 'This organization already has an active subscription', ErrorCode.CONFLICT);
      }

      const plan = await Plan.findOne({ _id: pending.planId, isActive: true });
      if (!plan) {
        return sendError(res, 500, 'Unable to map marketplace entitlement to a valid plan', ErrorCode.INTERNAL_ERROR);
      }

      const now = new Date();
      let subscription;
      try {
        subscription = await Subscription.create({
          orgId,
          planId: pending.planId,
          status: 'active',
          interval: pending.interval,
          currentPeriodStart: now,
          currentPeriodEnd: calculatePeriodEnd(now, pending.interval),
          cancelAtPeriodEnd: false,
          externalId: `aws_sub_${pending.awsCustomerIdentifier}`,
          externalCustomerId: pending.awsCustomerIdentifier,
          metadata: {
            provider: 'aws-marketplace',
            awsCustomerIdentifier: pending.awsCustomerIdentifier,
            awsProductCode: pending.awsProductCode,
            dimension: pending.dimension,
          },
        });
      } catch (e) {
        // A concurrent claim for the same org can still slip past the guards and
        // collide on the unique {orgId,status:active} index — surface the clean
        // 409 rather than a raw 500. (The ref is already consumed; a genuine
        // duplicate means the org is subscribed either way.)
        if ((e as { code?: number })?.code === 11000) {
          return sendError(res, 409, 'This organization already has an active subscription', ErrorCode.CONFLICT);
        }
        throw e;
      }

      // Sync tier to quota (no add-ons yet on a fresh bind) + record the event.
      // `''` auth ⇒ syncEntitlements mints a billing SERVICE token for the org —
      // never forward (or mis-pass a user id as) a caller credential.
      await syncEntitlements(orgId, plan.tier, '', subscription._id.toString(), subscription.addons ?? []);
      await createBillingEvent(orgId, 'subscription_created', {
        planId: pending.planId,
        tier: plan.tier,
        provider: 'aws-marketplace',
        awsCustomerIdentifier: pending.awsCustomerIdentifier,
      }, subscription._id.toString());

      // Mirror the bind to the CENTRAL audit trail like the self-serve create —
      // this is where an AWS Marketplace purchase becomes THIS org's paid
      // subscription. Fire-and-forget; plan/tier ids only: the AWS customer
      // identifier (and any AWS account id) is deliberately NOT recorded.
      getAuditClient().record({
        action: 'billing.subscription.create',
        actorId: req.user?.sub ?? 'system',
        orgId,
        targetId: subscription._id.toString(),
        details: { planId: pending.planId, interval: pending.interval, tier: plan.tier, provider: 'aws-marketplace' },
      }, 'billing');

      ctx.log('COMPLETED', 'Marketplace subscription claimed', { orgId, planId: pending.planId });
      return sendSuccess(res, 201, {
        subscription: {
          id: subscription._id.toString(),
          orgId,
          planId: pending.planId,
          planName: plan.name,
          status: 'active',
        },
      });
    }),
  );

  // POST /billing/marketplace/sns — SNS notification webhook
  // No auth — SNS uses signature verification instead

  router.post(
    '/marketplace/sns',
    async (req: Request, res: Response) => {
      // Set once we hold the dedup claim; released in catch so a transient
      // processing failure doesn't permanently short-circuit SNS's retries.
      let claim: { messageId: string; token: string } | undefined;
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
        // a guessable customerIdentifier and downgrade that org). Reject unless
        // the message came from exactly one of the configured topics (an empty
        // list therefore rejects everything).
        if (!config.marketplace.snsTopicArns.includes(snsMessage.TopicArn)) {
          logger.warn('marketplace SNS topic not configured / mismatch — rejecting', {
            expected: config.marketplace.snsTopicArns,
            received: snsMessage.TopicArn,
          });
          return sendError(res, 403, 'Unexpected SNS topic', ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        // Two-phase idempotency guard (crash-durable): SNS retries the same
        // MessageId on transient failures. Take a SHORT-LIVED in-progress claim
        // before processing — a duplicate/concurrent delivery short-circuits with
        // 200 (so SNS stops retrying) but skips side-effects. The durable
        // done-marker is written only AFTER processing succeeds (below), so a
        // mid-process crash lets the claim expire and SNS's retry re-runs the
        // event instead of it being stranded as "processed" for 30d.
        const claimToken = await claimWebhookEvent('sns', snsMessage.MessageId);
        if (!claimToken) {
          logger.info('Skipping duplicate SNS delivery', { messageId: snsMessage.MessageId, type: snsMessage.Type });
          return sendSuccess(res, 200, { message: 'Duplicate message acknowledged' });
        }
        claim = { messageId: snsMessage.MessageId, token: claimToken };

        // Do the work, capturing the success message — the done-marker is written
        // after the switch so EVERY successful branch promotes the claim exactly
        // once (and a throw skips it → the catch releases / the lease expires).
        let responseMessage: string;
        switch (snsMessage.Type) {
          case 'SubscriptionConfirmation': {
            if (snsMessage.SubscribeURL) {
              await confirmSNSSubscription(snsMessage.SubscribeURL);
              logger.info('SNS subscription confirmed', { topicArn: snsMessage.TopicArn });
            }
            responseMessage = 'Subscription confirmed';
            break;
          }

          case 'UnsubscribeConfirmation': {
            logger.info('SNS unsubscribe confirmation received', { topicArn: snsMessage.TopicArn });
            responseMessage = 'Unsubscribe acknowledged';
            break;
          }

          case 'Notification': {
            const notification: MarketplaceNotification = JSON.parse(snsMessage.Message);
            await processMarketplaceNotification(notification);
            responseMessage = 'Notification processed';
            break;
          }

          default:
            logger.warn('Unknown SNS message type', { type: snsMessage.Type });
            responseMessage = 'Unknown type acknowledged';
        }

        // Processing succeeded — promote the in-progress claim to the durable
        // done-marker so a redelivery is deduped (a crash before this re-runs).
        await markWebhookEventDone('sns', snsMessage.MessageId);
        return sendSuccess(res, 200, { message: responseMessage });
      } catch (error) {
        logger.error('Failed to process SNS notification', { error: errorMessage(error) });
        // Release the idempotency claim so SNS's retry of this MessageId
        // re-processes instead of being short-circuited as a duplicate (which
        // would silently drop the event on a transient failure).
        if (claim) await releaseWebhookEvent('sns', claim.messageId, claim.token).catch(() => {});
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

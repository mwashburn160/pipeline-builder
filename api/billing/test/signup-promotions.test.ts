// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/signup-promotions.ts — the one "a paid signup landed" hook shared by
 * the create route, Checkout provisioning and the settle-later webhook. It must
 * derive the trigger context correctly (interval, first subscription, plan
 * price) and be FAIL-SOFT on both legs: a promo or referral error is logged,
 * never thrown into the signup/webhook.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock, loggerMock } from './helpers/mock-api-core.js';

const logger = loggerMock();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createLogger: () => logger }));

const evaluatePromotions = jest.fn<AnyFn>(async () => []);
const processReferralSignup = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({ evaluatePromotions, processReferralSignup }));
const countDocuments = jest.fn<AnyFn>(async () => 1);
jest.unstable_mockModule('../src/models/subscription.js', () => ({ Subscription: { countDocuments } }));

const { runSignupPromotions } = await import('../src/helpers/signup-promotions.js');

const plan = { tier: 'pro', prices: { monthly: 4900, annual: 49000 } };
const sub = (over: Record<string, unknown> = {}) => ({ orgId: 'org_1', interval: 'monthly', ...over }) as any;

beforeEach(() => { jest.clearAllMocks(); });

describe('runSignupPromotions', () => {
  it('evaluates subscription_created promotions for a FIRST monthly subscription at the monthly price', async () => {
    await runSignupPromotions(sub(), plan, { source: 'create', actorId: 'u1' });
    expect(countDocuments).toHaveBeenCalledWith({ orgId: 'org_1' });
    expect(evaluatePromotions).toHaveBeenCalledWith('org_1', expect.anything(), 'subscription_created', {
      tier: 'pro', interval: 'monthly', planPriceCents: 4900, isFirstSubscription: true, actorId: 'u1',
    });
    expect(processReferralSignup).not.toHaveBeenCalled();
  });

  it('prices an annual, returning subscription at the annual price (and 0 for a plan without one)', async () => {
    countDocuments.mockResolvedValueOnce(2);
    await runSignupPromotions(sub({ interval: 'annual' }), plan, { source: 'webhook' });
    expect(evaluatePromotions).toHaveBeenLastCalledWith('org_1', expect.anything(), 'subscription_created', expect.objectContaining({ interval: 'annual', planPriceCents: 49000, isFirstSubscription: false }));
    await runSignupPromotions(sub(), { tier: 'pro' } as any, { source: 'webhook' });
    expect(evaluatePromotions).toHaveBeenLastCalledWith('org_1', expect.anything(), 'subscription_created', expect.objectContaining({ planPriceCents: 0 }));
  });

  it('records the referral (trimmed) with the trigger context; a blank code is ignored', async () => {
    await runSignupPromotions(sub(), plan, { source: 'checkout', referralCode: '  org_ref ' });
    expect(processReferralSignup).toHaveBeenCalledWith('org_1', 'org_ref', { tier: 'pro', interval: 'monthly', planPriceCents: 4900 });
    await runSignupPromotions(sub(), plan, { source: 'checkout', referralCode: '   ' });
    expect(processReferralSignup).toHaveBeenCalledTimes(1);
  });

  it('is fail-soft on both legs: errors are logged, the referral still runs after a promo failure', async () => {
    evaluatePromotions.mockRejectedValueOnce(new Error('promo boom'));
    processReferralSignup.mockRejectedValueOnce(new Error('referral boom'));
    await expect(runSignupPromotions(sub(), plan, { source: 'create', referralCode: 'org_ref' })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Promotion evaluation failed (subscription_created)', { orgId: 'org_1', source: 'create', error: 'promo boom' });
    expect(logger.error).toHaveBeenCalledWith('Referral processing failed (subscription_created)', { orgId: 'org_1', source: 'create', error: 'referral boom' });
  });
});

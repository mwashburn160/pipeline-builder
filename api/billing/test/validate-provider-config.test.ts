// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/validate-provider-config.ts — the boot-time provider sanity check.
 * It WARNS (never throws) so a half-configured price map is loud at startup
 * instead of a 500 at the first customer; each warning names exactly what is
 * missing.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock, loggerMock } from './helpers/mock-api-core.js';

const logger = loggerMock();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createLogger: () => logger }));

const billing = {
  plans: [
    { id: 'developer', tier: 'developer', prices: { monthly: 0, annual: 0 } },
    { id: 'pro', tier: 'pro', prices: { monthly: 4900, annual: 49000 } },
    { id: 'unlimited', tier: 'unlimited', prices: { monthly: 1, annual: 1 } },
  ],
  bundles: [{ id: 'seat_pack', prices: { monthly: 1000 } }] as Array<{ id: string; prices?: Record<string, number> }> | undefined,
};
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => billing },
}));

const cfg: Record<string, any> = {};
jest.unstable_mockModule('../src/config.js', () => ({ config: cfg }));

const { validateProviderConfig } = await import('../src/helpers/validate-provider-config.js');

const warnings = () => logger.warn.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(cfg)) delete cfg[k];
  billing.bundles = [{ id: 'seat_pack', prices: { monthly: 1000 } }];
});

describe('stripe', () => {
  it('is silent when the webhook secret and every chargeable price are configured', () => {
    Object.assign(cfg, { billingProvider: 'stripe', stripe: { webhookSecret: 'whsec', priceToPlanMap: { pro_monthly: 'p1', pro_annual: 'p2', seat_pack_monthly: 'p3' } } });
    validateProviderConfig();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('names the missing webhook secret and every unpriced plan/bundle × interval (never the free or unlimited tiers)', () => {
    Object.assign(cfg, { billingProvider: 'stripe', stripe: { webhookSecret: '' } });
    validateProviderConfig();
    expect(warnings()[0]).toContain('STRIPE_WEBHOOK_SECRET is not set');
    expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('STRIPE_PRICE_MAP is missing entries'), { missing: ['pro_monthly', 'pro_annual', 'seat_pack_monthly'] });
  });

  it('tolerates a config with no bundles and no plan prices', () => {
    billing.bundles = undefined;
    Object.assign(cfg, { billingProvider: 'stripe', stripe: { webhookSecret: 'whsec', priceToPlanMap: { pro_monthly: 'a', pro_annual: 'b' } } });
    validateProviderConfig();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('aws-marketplace', () => {
  const mp = (over: Record<string, unknown> = {}) => ({
    snsTopicArns: ['arn:aws:sns:us-east-1:1:aws-mp-subscription-notification-x', 'arn:aws:sns:us-east-1:1:aws-mp-entitlement-notification-x'],
    dimensionToPlanMap: { pro: 'pro' },
    dimensionPriceMap: { pro: 1 },
    ...over,
  });

  it('is silent when both SNS topics and the dimension maps are set', () => {
    Object.assign(cfg, { billingProvider: 'aws-marketplace', meteringEnabled: true, marketplace: mp() });
    validateProviderConfig();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when no SNS topic is configured at all', () => {
    Object.assign(cfg, { billingProvider: 'aws-marketplace', marketplace: mp({ snsTopicArns: [] }) });
    validateProviderConfig();
    expect(warnings()).toEqual([expect.stringContaining('AWS_MARKETPLACE_SNS_TOPIC_ARN is not set')]);
  });

  it('warns per missing topic class, an empty dimension map, and metering without prices', () => {
    Object.assign(cfg, { billingProvider: 'aws-marketplace', meteringEnabled: true, marketplace: mp({ snsTopicArns: ['arn:aws:sns:us-east-1:1:other'], dimensionToPlanMap: {}, dimensionPriceMap: {} }) });
    validateProviderConfig();
    expect(warnings()).toEqual([
      expect.stringContaining('no aws-mp-subscription-notification topic'),
      expect.stringContaining('no aws-mp-entitlement-notification topic'),
      expect.stringContaining('AWS_MARKETPLACE_DIMENSION_MAP is empty'),
      expect.stringContaining('AWS_MARKETPLACE_DIMENSION_PRICE_MAP is empty'),
    ]);
  });
});

it('checks nothing for other providers', () => {
  Object.assign(cfg, { billingProvider: 'stub' });
  validateProviderConfig();
  expect(logger.warn).not.toHaveBeenCalled();
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS_MARKETPLACE_SNS_TOPIC_ARN is a comma-separated allowlist — a SaaS listing
 * has a subscription AND an entitlement topic, and the webhook must accept both.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

const SUB = 'arn:aws:sns:us-east-1:287250355862:aws-mp-subscription-notification-prod';
const ENT = 'arn:aws:sns:us-east-1:287250355862:aws-mp-entitlement-notification-prod';

async function loadTopicArns(value: string | undefined): Promise<string[]> {
  if (value === undefined) delete process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN;
  else process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN = value;
  // config.ts refuses to load without a Mongo URI when billing is enabled.
  process.env.MONGODB_URI ??= 'mongodb://test:27017/billing';
  // Cache-bust so config.ts re-reads the env on each import.
  const mod = await import(`../src/config.js?sns=${Math.random()}`);
  return mod.config.marketplace.snsTopicArns;
}

describe('config.marketplace.snsTopicArns', () => {
  const original = process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN;
  const originalMongo = process.env.MONGODB_URI;
  afterEach(() => {
    if (originalMongo === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalMongo;
    if (original === undefined) delete process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN;
    else process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN = original;
  });

  it('is empty when unset (webhook then fails closed)', async () => {
    expect(await loadTopicArns(undefined)).toEqual([]);
    expect(await loadTopicArns('')).toEqual([]);
  });

  it('accepts a single ARN', async () => {
    expect(await loadTopicArns(SUB)).toEqual([SUB]);
  });

  it('splits a comma-separated list, trimming whitespace and dropping empty entries', async () => {
    expect(await loadTopicArns(` ${SUB} , ${ENT},, `)).toEqual([SUB, ENT]);
  });
});

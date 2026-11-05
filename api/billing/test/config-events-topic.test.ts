// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS_MARKETPLACE_EVENTS_TOPIC_ARN is the one topic the Marketplace webhook
 * accepts: the platform-owned topic the EventBridge rule forwards license
 * events to.
 */

import { describe, it, expect, afterEach } from '@jest/globals';

const EVENTS = 'arn:aws:sns:us-east-1:111122223333:pipeline-builder-marketplace-events';

async function loadEventsTopic(value: string | undefined): Promise<string> {
  if (value === undefined) delete process.env.AWS_MARKETPLACE_EVENTS_TOPIC_ARN;
  else process.env.AWS_MARKETPLACE_EVENTS_TOPIC_ARN = value;
  // config.ts refuses to load without a Mongo URI when billing is enabled.
  process.env.MONGODB_URI ??= 'mongodb://test:27017/billing';
  // Cache-bust so config.ts re-reads the env on each import.
  const mod = await import(`../src/config.js?events=${Math.random()}`);
  return mod.config.marketplace.eventsTopicArn;
}

describe('config.marketplace.eventsTopicArn', () => {
  const original = process.env.AWS_MARKETPLACE_EVENTS_TOPIC_ARN;
  const originalMongo = process.env.MONGODB_URI;
  afterEach(() => {
    if (originalMongo === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalMongo;
    if (original === undefined) delete process.env.AWS_MARKETPLACE_EVENTS_TOPIC_ARN;
    else process.env.AWS_MARKETPLACE_EVENTS_TOPIC_ARN = original;
  });

  it('is empty when unset (the webhook then fails closed)', async () => {
    expect(await loadEventsTopic(undefined)).toBe('');
    expect(await loadEventsTopic('')).toBe('');
  });

  it('reads the topic ARN, trimming whitespace', async () => {
    expect(await loadEventsTopic(` ${EVENTS} `)).toBe(EVENTS);
  });
});

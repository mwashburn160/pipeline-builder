// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-Alertmanager-instance binding config parser. The parser
 * tolerates missing/malformed input — service must NOT crash on bad
 * ALERT_WEBHOOK_INSTANCES; it should fall back to legacy single-token mode.
 */

import type { AlertWebhookInstance } from '../src/config';

const ORIGINAL_INSTANCES = process.env.ALERT_WEBHOOK_INSTANCES;

function loadConfig(): { instances: AlertWebhookInstance[] } {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../src/config');
  return mod.config.alertWebhook;
}

beforeEach(() => {
  // Reset env between tests so the config-module top-level read sees what we set.
  delete process.env.ALERT_WEBHOOK_INSTANCES;
  // Config module's `requireSecret()` checks NODE_ENV=development; jest sets
  // it to 'test' by default which makes the module throw at load time on
  // missing JWT_SECRET. Force dev mode for these config-loading tests.
  process.env.NODE_ENV = 'development';
  // Config module also throws at load if MONGODB_URI is unset (it's a hard
  // requirement for the platform process). Stub it so we can load the module.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://stub:27017/test';
});

afterAll(() => {
  if (ORIGINAL_INSTANCES === undefined) delete process.env.ALERT_WEBHOOK_INSTANCES;
  else process.env.ALERT_WEBHOOK_INSTANCES = ORIGINAL_INSTANCES;
});

describe('parseAlertWebhookInstances', () => {
  it('returns [] when env is unset (legacy single-token mode)', () => {
    expect(loadConfig().instances).toEqual([]);
  });

  it('parses a well-formed JSON array of instances', () => {
    process.env.ALERT_WEBHOOK_INSTANCES = JSON.stringify([
      { id: 'prod-am-0', token: 'tok-prod' },
      { id: 'staging-am-0', token: 'tok-staging', allowedOrgIds: ['org-a', 'org-b'] },
    ]);
    expect(loadConfig().instances).toEqual([
      { id: 'prod-am-0', token: 'tok-prod' },
      { id: 'staging-am-0', token: 'tok-staging', allowedOrgIds: ['org-a', 'org-b'] },
    ]);
  });

  it('drops entries missing id or token rather than throwing', () => {
    process.env.ALERT_WEBHOOK_INSTANCES = JSON.stringify([
      { id: 'good', token: 'good-tok' },
      { id: '', token: 'no-id' },
      { id: 'no-tok', token: '' },
      { token: 'no-id-field' },
      { id: 'no-tok-field' },
      'not-an-object',
      null,
    ]);
    expect(loadConfig().instances).toEqual([{ id: 'good', token: 'good-tok' }]);
  });

  it('ignores allowedOrgIds when it is not an array of strings', () => {
    process.env.ALERT_WEBHOOK_INSTANCES = JSON.stringify([
      { id: 'mixed', token: 't', allowedOrgIds: ['org-a', 42, 'org-c'] },
      { id: 'object', token: 't', allowedOrgIds: { not: 'an array' } },
    ]);
    const out = loadConfig().instances;
    // Both entries pass the id+token check; allowedOrgIds is silently
    // dropped when not a clean string[].
    expect(out).toHaveLength(2);
    expect(out[0].allowedOrgIds).toBeUndefined();
    expect(out[1].allowedOrgIds).toBeUndefined();
  });

  it('returns [] when env contains malformed JSON (falls back to legacy)', () => {
    process.env.ALERT_WEBHOOK_INSTANCES = 'this-is-not-json';
    expect(loadConfig().instances).toEqual([]);
  });

  it('returns [] when env contains a JSON non-array (e.g. an object)', () => {
    process.env.ALERT_WEBHOOK_INSTANCES = JSON.stringify({ id: 'a', token: 'b' });
    expect(loadConfig().instances).toEqual([]);
  });
});

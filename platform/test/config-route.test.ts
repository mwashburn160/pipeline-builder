// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /config — the public client-bootstrap payload. Asserts: it reports the
 * service feature flags + deployTarget (default 'local'); it exposes the effective
 * per-tier quota presets (pkg#9 — sourced from api-core QUOTA_TIERS so env
 * overrides are honored, four displayed dims only); and it leaks no secret config
 * (SMTP creds, KMS ARNs, OAuth client secrets, AWS keys).
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// A known QUOTA_TIERS shape so we can assert tierPresets echoes the four displayed
// dims (and nothing else) per tier.
const QUOTA_TIERS = {
  developer: { label: 'Developer', limits: { plugins: 25, pipelines: 2, apiCalls: 25000, aiCalls: 25, seats: 1, storageBytes: 1, dashboards: -1, alertRules: -1, alertDestinations: -1, idpConfigs: 1, eventRetentionDays: 30, doraRetentionDays: 180 } },
  pro: { label: 'Pro', limits: { plugins: 50, pipelines: 5, apiCalls: 250000, aiCalls: 1000, seats: 1, storageBytes: 1, dashboards: -1, alertRules: -1, alertDestinations: -1, idpConfigs: 5, eventRetentionDays: 30, doraRetentionDays: 180 } },
  team: { label: 'Team', limits: { plugins: 75, pipelines: 6, apiCalls: 500000, aiCalls: 2500, seats: 3, storageBytes: 1, dashboards: -1, alertRules: -1, alertDestinations: -1, idpConfigs: 5, eventRetentionDays: 30, doraRetentionDays: 180 } },
  enterprise: { label: 'Enterprise', limits: { plugins: 150, pipelines: 30, apiCalls: 900000, aiCalls: 9000, seats: 15, storageBytes: 1, dashboards: -1, alertRules: -1, alertDestinations: -1, idpConfigs: -1, eventRetentionDays: 30, doraRetentionDays: 180 } },
  unlimited: { label: 'Unlimited', limits: { plugins: -1, pipelines: -1, apiCalls: -1, aiCalls: -1, seats: -1, storageBytes: -1, dashboards: -1, alertRules: -1, alertDestinations: -1, idpConfigs: -1, eventRetentionDays: -1, doraRetentionDays: -1 } },
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  getPrimarySupportAlias: () => 'support@pb.example',
  getAllSupportAliases: () => ['support@pb.example', 'help@pb.example'],
  QUOTA_TIERS,
  VALID_TIERS: ['developer', 'pro', 'team', 'enterprise', 'unlimited'],
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    billing: { enabled: true },
    email: { enabled: false, provider: 'ses', ses: { secretAccessKey: 'SUPER_SECRET' }, smtp: { pass: 'smtp-password' } },
    oauth: { google: { enabled: true, clientSecret: 'oauth-client-secret' } },
    deployTarget: 'local',
    kms: { keyArn: 'arn:aws:kms:us-east-1:123:key/abc' },
  },
}));

const { default: configRouter } = await import('../src/routes/config.js');

// Pull the `GET /` handler out of the router (supertest isn't a platform dep) and
// drive it with a minimal req/res. `sendSuccess` (mocked) → res.status().json().
type Handler = (req: unknown, res: unknown) => void;
const handler = (configRouter as any).stack[0].route.stack[0].handle as Handler;

function invoke(): { status: number; body: any } {
  const captured: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = {
    set: () => res,
    status: (code: number) => { captured.status = code; return res; },
    json: (obj: unknown) => { captured.body = obj; return res; },
  };
  handler({}, res);
  return captured;
}

describe('GET /config', () => {
  it('reports service feature flags and the deployTarget default', () => {
    const res = invoke();
    expect(res.status).toBe(200);
    expect(res.body.data.serviceFeatures).toEqual({ billing: true, email: false, oauth: true });
    expect(res.body.data.deployTarget).toBe('local');
    expect(res.body.data.supportAlias).toBe('support@pb.example');
    expect(res.body.data.supportAliases).toEqual(['support@pb.example', 'help@pb.example']);
  });

  it('exposes effective per-tier presets with only the four displayed dimensions (pkg#9)', () => {
    const presets = invoke().body.data.tierPresets;
    expect(Object.keys(presets).sort()).toEqual(['developer', 'enterprise', 'pro', 'team', 'unlimited']);
    // Values come straight from QUOTA_TIERS (env-override-aware source).
    expect(presets.pro).toEqual({ plugins: 50, pipelines: 5, apiCalls: 250000, aiCalls: 1000 });
    expect(presets.enterprise).toEqual({ plugins: 150, pipelines: 30, apiCalls: 900000, aiCalls: 9000 });
    // Non-displayed dims (seats/storage/retention) are NOT exposed here.
    expect(presets.pro).not.toHaveProperty('seats');
    expect(presets.pro).not.toHaveProperty('eventRetentionDays');
  });

  it('leaks no secret configuration', () => {
    const body = JSON.stringify(invoke().body);
    expect(body).not.toContain('SUPER_SECRET');
    expect(body).not.toContain('smtp-password');
    expect(body).not.toContain('oauth-client-secret');
    expect(body).not.toContain('arn:aws:kms');
  });
});

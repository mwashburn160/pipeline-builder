// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rotation drill for the Alertmanager relay bearer
 * (ALERT_WEBHOOK_INSTANCE_TOKEN — docs/runbooks/secret-rotation.md): while the
 * instance entry carries a `previousToken`, BOTH tokens are accepted; once it's
 * gone the old one is rejected. Anything else would mean either a gap where
 * Alertmanager's alerts are dropped mid-rotation, or an old bearer that keeps
 * working forever.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { AlertWebhookInstance } from '../src/config/index.js';

const instances: AlertWebhookInstance[] = [];
const mockRelay = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (r: any, status: number, message: string) => r.status(status).json({ success: false, message }),
  sendSuccess: (r: any, status: number, data: unknown) => r.status(status).json({ success: true, data }),
  sendQuotaReserveDenied: jest.fn(),
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/middleware/quota.js', () => ({
  reserveFeatureQuota: jest.fn(),
  releaseFeatureQuota: jest.fn(),
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    alertWebhook: { get instances() { return instances; } },
    observability: { alertDestinationMaxLabel: 80, alertDestinationMaxTarget: 500 },
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  softDeleteRetentionMs: () => 0,
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

jest.unstable_mockModule('../src/services/alert-relay.js', () => ({
  relayWebhook: (...a: unknown[]) => mockRelay(...a),
}));

jest.unstable_mockModule('../src/services/alert-destination-service.js', () => ({
  alertDestinationService: {},
  DestinationNotFoundError: class extends Error {},
  toApiDestination: (d: unknown) => d,
}));

const { alertWebhook } = await import('../src/controllers/alert-destinations.js');

function req(token: string): Request {
  return {
    headers: { 'authorization': `Bearer ${token}`, 'x-alertmanager-instance': 'alertmanager' },
    body: { alerts: [{ labels: { org_id: 'org-a' } }] },
  } as unknown as Request;
}

function res(): Response & { _status: number; _body: unknown } {
  const r = {
    _status: 0,
    _body: null as unknown,
    status(code: number) { r._status = code; return r; },
    json(body: unknown) { r._body = body; return r; },
  };
  return r as unknown as Response & { _status: number; _body: unknown };
}

const call = async (token: string) => {
  const r = res();
  await (alertWebhook as unknown as (rq: Request, rs: Response) => Promise<void>)(req(token), r);
  return r;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRelay.mockResolvedValue({ delivered: 1, failed: 0 });
  instances.length = 0;
});

describe('alert-relay token rotation', () => {
  it('accepts only the current token before a rotation', async () => {
    instances.push({ id: 'alertmanager', token: 'tok-new' });
    expect((await call('tok-new'))._status).toBe(200);
    expect((await call('tok-old'))._status).toBe(401);
  });

  it('accepts BOTH tokens while previousToken is set', async () => {
    instances.push({ id: 'alertmanager', token: 'tok-new', previousToken: 'tok-old' });
    expect((await call('tok-new'))._status).toBe(200);
    expect((await call('tok-old'))._status).toBe(200);
    expect(mockRelay).toHaveBeenCalledTimes(2);
  });

  it('rejects the old token once previousToken is cleared (rotation finished)', async () => {
    instances.push({ id: 'alertmanager', token: 'tok-new' });
    expect((await call('tok-old'))._status).toBe(401);
    expect(mockRelay).not.toHaveBeenCalled();
  });

  it('rejects a token matching neither, and a wrong-length token, during the overlap', async () => {
    instances.push({ id: 'alertmanager', token: 'tok-new', previousToken: 'tok-old' });
    expect((await call('tok-other'))._status).toBe(401);
    expect((await call('tok'))._status).toBe(401);
  });
});

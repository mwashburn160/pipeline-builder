// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin-ecosystem API domain (plan W1): every method hits the contract's
 * path with the right verb and body, and the step-up-gated console writes carry
 * the `X-Step-Up-Token` header.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ApiCore } from '../src/lib/api/core';
import { ecosystemApi } from '../src/lib/api/domains/ecosystem';

function fakeCore() {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const core = {
    request: jest.fn<AnyFn>((path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return Promise.resolve({ success: true, statusCode: 200, data: {} });
    }),
    stepUpHeader: (t?: string) => (t ? { 'X-Step-Up-Token': t } : {}),
  } as unknown as ApiCore;
  return { api: ecosystemApi(core), calls };
}

const body = (init: RequestInit) => (init.body ? JSON.parse(String(init.body)) : undefined);

describe('ecosystem API — tenant routes', () => {
  it('reads and writes the publisher profile', async () => {
    const { api, calls } = fakeCore();
    await api.getPublisher();
    await api.createPublisher({ handle: 'acme', displayName: 'Acme', termsVersion: '2026-09' });
    await api.updatePublisher({ description: null, homepageUrl: 'https://acme.dev' });
    await api.acceptPublisherTerms('2026-09');

    expect(calls[0].path).toBe('/api/plugins/publisher');
    expect(calls[0].init.method).toBeUndefined();
    expect(calls[1]).toMatchObject({ path: '/api/plugins/publisher', init: { method: 'POST' } });
    expect(body(calls[1].init)).toEqual({ handle: 'acme', displayName: 'Acme', termsVersion: '2026-09' });
    expect(calls[2].init.method).toBe('PATCH');
    expect(body(calls[2].init)).toEqual({ description: null, homepageUrl: 'https://acme.dev' });
    expect(calls[3].path).toBe('/api/plugins/publisher/terms');
    expect(body(calls[3].init)).toEqual({ termsVersion: '2026-09' });
  });

  it('pauses a whole listing or one version', async () => {
    const { api, calls } = fakeCore();
    await api.pauseListing('l 1');
    await api.pauseListing('l1', '1.2.0');
    expect(calls[0].path).toBe('/api/plugins/publisher/listings/l%201/pause');
    expect(body(calls[0].init)).toEqual({});
    expect(body(calls[1].init)).toEqual({ version: '1.2.0' });
  });

  it('lists, drafts, submits and withdraws requests', async () => {
    const { api, calls } = fakeCore();
    await api.listPublishRequests({ status: 'pending' });
    await api.listPublishRequests();
    await api.getPublishDraft('p-1');
    await api.submitPublishRequest({ kind: 'yank', listingId: 'l1', version: '1.0.0', reason: 'cve' });
    await api.withdrawPublishRequest('r1');
    await api.listPublisherListings();
    await api.listIncomingTransfers();

    expect(calls[0].path).toBe('/api/plugins/publish-requests?status=pending');
    expect(calls[1].path).toBe('/api/plugins/publish-requests');
    expect(calls[2].path).toBe('/api/plugins/publish-requests/draft?pluginId=p-1');
    expect(calls[3]).toMatchObject({ path: '/api/plugins/publish-requests', init: { method: 'POST' } });
    expect(body(calls[3].init)).toEqual({ kind: 'yank', listingId: 'l1', version: '1.0.0', reason: 'cve' });
    expect(calls[4]).toMatchObject({ path: '/api/plugins/publish-requests/r1/withdraw', init: { method: 'POST' } });
    expect(calls[5].path).toBe('/api/plugins/publisher/listings');
    expect(calls[6].path).toBe('/api/plugins/publisher/incoming-transfers');
  });

  it('answers a transfer with the step-up token', async () => {
    const { api, calls } = fakeCore();
    await api.respondToTransfer('r9', true, 'tok');
    expect(calls[0].path).toBe('/api/plugins/publish-requests/r9/transfer-response');
    expect(body(calls[0].init)).toEqual({ accept: true });
    expect(calls[0].init.headers).toEqual({ 'X-Step-Up-Token': 'tok' });
  });
});

describe('ecosystem API — console routes', () => {
  it('reads the queue with filters and a request detail', async () => {
    const { api, calls } = fakeCore();
    await api.getEcosystemOverview();
    await api.listEcosystemRequests({ status: 'open', kind: 'verify', lane: 'security', limit: 50 });
    await api.getEcosystemRequest('r1');
    expect(calls[0].path).toBe('/api/plugins/ecosystem/overview');
    const q = new URLSearchParams(calls[1].path.split('?')[1]);
    expect(calls[1].path.startsWith('/api/plugins/ecosystem/requests?')).toBe(true);
    expect(Object.fromEntries(q)).toEqual({ status: 'open', kind: 'verify', lane: 'security', limit: '50' });
    expect(calls[2].path).toBe('/api/plugins/ecosystem/requests/r1');
  });

  it('decides requests (step-up forwarded; note optional)', async () => {
    const { api, calls } = fakeCore();
    await api.approveEcosystemRequest('r1', undefined, 'tok');
    await api.secondApproveEcosystemRequest('r1', 'lgtm');
    await api.rejectEcosystemRequest('r1', 'nope');
    expect(calls[0]).toMatchObject({ path: '/api/plugins/ecosystem/requests/r1/approve', init: { method: 'POST' } });
    expect(body(calls[0].init)).toEqual({});
    expect(calls[0].init.headers).toEqual({ 'X-Step-Up-Token': 'tok' });
    expect(body(calls[1].init)).toEqual({ note: 'lgtm' });
    expect(calls[1].init.headers).toEqual({});
    expect(calls[2].path).toBe('/api/plugins/ecosystem/requests/r1/reject');
    expect(body(calls[2].init)).toEqual({ reason: 'nope' });
  });

  it('manages publishers and listings', async () => {
    const { api, calls } = fakeCore();
    await api.listEcosystemPublishers({ tier: 'verified', suspended: false, q: 'ac' });
    await api.suspendPublisher('p1', 'spam', 't1');
    await api.unsuspendPublisher('p1', undefined, 't2');
    await api.setPublisherTier('p1', 'verified', 'domain ok', 't3');
    await api.listEcosystemListings({ state: 'suspended' });
    await api.setListingState('l1', 'unmaintained', 'stale', 't4');
    await api.yankListingVersion('l1', '1.0.0', 'cve', 't5');
    await api.requestUnyankListingVersion('l1', '1.0.0', 'fixed', 't6');
    await api.resignAllPublishedImages('key rotated', 't7');

    expect(calls[0].path).toBe('/api/plugins/ecosystem/publishers?tier=verified&suspended=false&q=ac');
    expect(calls[1].path).toBe('/api/plugins/ecosystem/publishers/p1/suspend');
    expect(body(calls[1].init)).toEqual({ reason: 'spam' });
    expect(calls[1].init.headers).toEqual({ 'X-Step-Up-Token': 't1' });
    expect(body(calls[2].init)).toEqual({});
    expect(body(calls[3].init)).toEqual({ tier: 'verified', reason: 'domain ok' });
    expect(calls[4].path).toBe('/api/plugins/ecosystem/listings?state=suspended');
    expect(calls[5].path).toBe('/api/plugins/ecosystem/listings/l1/state');
    expect(body(calls[5].init)).toEqual({ state: 'unmaintained', reason: 'stale' });
    expect(calls[6].path).toBe('/api/plugins/ecosystem/listings/l1/versions/1.0.0/yank');
    expect(calls[7].path).toBe('/api/plugins/ecosystem/listings/l1/versions/1.0.0/unyank');
    expect(calls[7].init.headers).toEqual({ 'X-Step-Up-Token': 't6' });
    expect(calls[8].path).toBe('/api/plugins/ecosystem/resign');
    expect(body(calls[8].init)).toEqual({ reason: 'key rotated' });
    expect(calls[8].init.headers).toEqual({ 'X-Step-Up-Token': 't7' });
  });

  it('manages auto-approval rules with step-up', async () => {
    const { api, calls } = fakeCore();
    const conditions = { requestKinds: ['new_version' as const], publisherTiers: ['verified' as const], bumps: ['patch' as const] };
    await api.listAutoRules();
    await api.createAutoRule({ name: 'r', conditions }, 't1');
    await api.updateAutoRule('r1', { enabled: false }, 't2');
    await api.approveAutoRuleChange('r1', 't3');
    await api.deleteAutoRule('r1', 't4');
    expect(calls[0].path).toBe('/api/plugins/ecosystem/rules');
    expect(calls[1].init.method).toBe('POST');
    expect(body(calls[1].init)).toEqual({ name: 'r', conditions });
    expect(calls[2]).toMatchObject({ path: '/api/plugins/ecosystem/rules/r1', init: { method: 'PATCH' } });
    expect(calls[2].init.headers).toEqual({ 'X-Step-Up-Token': 't2' });
    expect(calls[3].path).toBe('/api/plugins/ecosystem/rules/r1/approve-change');
    expect(calls[3].init.body).toBeUndefined();
    expect(calls[4]).toMatchObject({ path: '/api/plugins/ecosystem/rules/r1', init: { method: 'DELETE', headers: { 'X-Step-Up-Token': 't4' } } });
  });

  it('manages reserved names (name path-encoded)', async () => {
    const { api, calls } = fakeCore();
    await api.listReservedNames();
    await api.putReservedName('acme.io', { reason: 'Vendor', publisherId: 'pub1' });
    await api.deleteReservedName('a/b');
    expect(calls[0].path).toBe('/api/plugins/ecosystem/reserved-names');
    expect(calls[1]).toMatchObject({ path: '/api/plugins/ecosystem/reserved-names/acme.io', init: { method: 'PUT' } });
    expect(body(calls[1].init)).toEqual({ reason: 'Vendor', publisherId: 'pub1' });
    expect(calls[2]).toMatchObject({ path: '/api/plugins/ecosystem/reserved-names/a%2Fb', init: { method: 'DELETE' } });
  });
});

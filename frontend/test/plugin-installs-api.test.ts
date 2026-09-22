// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The W2 install / catalog / policy API domain: every method hits the contract's
 * path with the right verb and body; the policy write carries the step-up token.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ApiCore } from '../src/lib/api/core';
import { pluginInstallsApi } from '../src/lib/api/domains/plugin-installs';

function fakeCore() {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const core = {
    request: jest.fn<AnyFn>((path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return Promise.resolve({ success: true, statusCode: 200, data: {} });
    }),
    stepUpHeader: (t?: string) => (t ? { 'X-Step-Up-Token': t } : {}),
  } as unknown as ApiCore;
  return { api: pluginInstallsApi(core), calls };
}

const body = (init: RequestInit) => (init.body ? JSON.parse(String(init.body)) : undefined);

describe('plugin installs API', () => {
  it('reads the catalog with its filters', async () => {
    const { api, calls } = fakeCore();
    await api.getPluginCatalog();
    await api.getPluginCatalog({ q: 'tf plan', category: 'deploy', installed: false });
    expect(calls[0].path).toBe('/api/plugins/catalog');
    expect(calls[1].path).toBe('/api/plugins/catalog?q=tf+plan&category=deploy&installed=false');
    expect(calls[1].init.method).toBeUndefined();
  });

  it('reads a listing install state with encoded segments', async () => {
    const { api, calls } = fakeCore();
    await api.getListingInstallState('acme co', 'tf/plan');
    expect(calls[0].path).toBe('/api/plugins/listings/acme%20co/tf%2Fplan/install-state');
  });

  it('lists installs, optionally with the implicit Official ones', async () => {
    const { api, calls } = fakeCore();
    await api.listPluginInstalls();
    await api.listPluginInstalls({ status: 'pending_approval', implicit: true });
    expect(calls[0].path).toBe('/api/plugins/installs');
    expect(calls[1].path).toBe('/api/plugins/installs?status=pending_approval&implicit=true');
  });

  it('creates, updates, deletes, approves and denies installs', async () => {
    const { api, calls } = fakeCore();
    await api.createPluginInstall({ publisher: 'acme', name: 'terraform-plan', versionPolicy: 'pinned', version: '1.0.0' });
    await api.updatePluginInstall('i 1', { version: '2.0.0' });
    await api.deletePluginInstall('i1');
    await api.approvePluginInstall('i1');
    await api.denyPluginInstall('i1', 'not vetted');
    await api.denyPluginInstall('i2');

    expect(calls[0]).toMatchObject({ path: '/api/plugins/installs', init: { method: 'POST' } });
    expect(body(calls[0].init)).toEqual({ publisher: 'acme', name: 'terraform-plan', versionPolicy: 'pinned', version: '1.0.0' });
    expect(calls[1]).toMatchObject({ path: '/api/plugins/installs/i%201', init: { method: 'PATCH' } });
    expect(body(calls[1].init)).toEqual({ version: '2.0.0' });
    expect(calls[2]).toMatchObject({ path: '/api/plugins/installs/i1', init: { method: 'DELETE' } });
    expect(calls[3]).toMatchObject({ path: '/api/plugins/installs/i1/approve', init: { method: 'POST' } });
    expect(calls[4]).toMatchObject({ path: '/api/plugins/installs/i1/deny', init: { method: 'POST' } });
    expect(body(calls[4].init)).toEqual({ reason: 'not vetted' });
    expect(body(calls[5].init)).toEqual({});
  });

  it('reads the policy and saves a partial policy with the step-up token', async () => {
    const { api, calls } = fakeCore();
    await api.getInstallPolicy();
    await api.updateInstallPolicy({ blockOnAdvisory: 'high' }, 'tok');
    expect(calls[0].path).toBe('/api/plugins/install-policy');
    expect(calls[1]).toMatchObject({ path: '/api/plugins/install-policy', init: { method: 'PUT', headers: { 'X-Step-Up-Token': 'tok' } } });
    expect(body(calls[1].init)).toEqual({ blockOnAdvisory: 'high' });
  });

  it('reads the shadowing report', async () => {
    const { api, calls } = fakeCore();
    await api.getPluginShadowing();
    expect(calls[0].path).toBe('/api/plugins/shadowing');
  });
});

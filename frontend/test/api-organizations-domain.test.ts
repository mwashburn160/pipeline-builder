// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * lib/api/domains/organizations.ts — every organization/member/role/IdP/policy
 * client call goes through ApiCore with the right method and an `/api/…` path,
 * step-up-gated calls forward the step-up token header, and the raw export
 * bypasses the envelope (and throws on a non-2xx).
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { organizationsApi } from '@/lib/api/domains/organizations';
import type { ApiCore } from '@/lib/api/core';

type Call = { path: string; init?: RequestInit };

function fakeCore() {
  const calls: Call[] = [];
  const core = {
    request: jest.fn(async (path: string, init?: RequestInit) => { calls.push({ path, init }); return { success: true, data: {} }; }),
    stepUpHeader: jest.fn((token?: string) => (token ? { 'X-Step-Up-Token': token } : {})),
    authHeaders: jest.fn(() => ({ Authorization: 'Bearer t' })),
    ensureFreshToken: jest.fn(async () => undefined),
  };
  return { core: core as unknown as ApiCore, calls, raw: core };
}

/** A plausible argument for a parameter, by position — strings for ids, objects for bodies. */
const argFor = (i: number): unknown => (i === 0 ? 'id-1' : i === 1 ? 'id-2' : 'tok-step-up');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('organizationsApi', () => {
  it('every call issues exactly one /api request (or the raw export fetch)', async () => {
    const { core, calls } = fakeCore();
    const api = organizationsApi(core);
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{"org":1}' }));
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const names = Object.keys(api) as Array<keyof typeof api>;
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      const fn = api[name] as unknown as (...a: unknown[]) => Promise<unknown>;
      const before = calls.length + fetchMock.mock.calls.length;
      const args = Array.from({ length: Math.max(fn.length, 3) }, (_v, i) => argFor(i));
      // Object-shaped params get an object; the function body only forwards them.
      await fn(...args.map((a, i) => (i > 0 && fn.length > i ? { value: a } : a))).catch(() => undefined);
      const after = calls.length + fetchMock.mock.calls.length;
      expect({ name, requests: after - before }).toEqual({ name, requests: 1 });
    }
    for (const c of calls) expect(c.path.startsWith('/api/')).toBe(true);
  });

  it('forwards the step-up token on a step-up-gated call', async () => {
    const { core, calls, raw } = fakeCore();
    await organizationsApi(core).updateOrganizationTier('org-1', 'team' as never, 'su-token');
    expect(raw.stepUpHeader).toHaveBeenCalledWith('su-token');
    expect(calls[0]).toMatchObject({ path: '/api/organization/org-1/tier', init: { method: 'PATCH' } });
    expect(JSON.stringify(calls[0]!.init)).toContain('X-Step-Up-Token');
  });

  it('the raw export returns the body text, and throws on failure', async () => {
    const { core, raw } = fakeCore();
    const api = organizationsApi(core);
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{"a":1}' }));
    await expect(api.exportOrganization('org-1')).resolves.toBe('{"a":1}');
    expect(raw.ensureFreshToken).toHaveBeenCalled();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => '' }));
    await expect(api.exportOrganization('org-1')).rejects.toThrow('Failed to export organization: 403 Forbidden');
  });
});

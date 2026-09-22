// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * lib/api/domains/organizations.ts — every organization/member/role/IdP/policy
 * client call goes through ApiCore with the right method and an `/api/…` path,
 * step-up-gated calls forward the step-up token header, and the export reads
 * the body as text (it is not the envelope).
 */

import { describe, expect, it, jest } from '@jest/globals';
import { organizationsApi } from '@/lib/api/domains/organizations';
import type { ApiCore } from '@/lib/api/core';

type Call = { path: string; init?: RequestInit };

function fakeCore() {
  const calls: Call[] = [];
  const core = {
    request: jest.fn(async (path: string, init?: RequestInit) => { calls.push({ path, init }); return { success: true, data: {} }; }),
    requestText: jest.fn(async (path: string, init?: RequestInit) => { calls.push({ path, init }); return '{"org":1}'; }),
    stepUpHeader: jest.fn((token?: string) => (token ? { 'X-Step-Up-Token': token } : {})),
    authHeaders: jest.fn(() => ({ Authorization: 'Bearer t' })),
    ensureFreshToken: jest.fn(async () => undefined),
  };
  return { core: core as unknown as ApiCore, calls, raw: core };
}

/** A plausible argument for a parameter, by position — strings for ids, objects for bodies. */
const argFor = (i: number): unknown => (i === 0 ? 'id-1' : i === 1 ? 'id-2' : 'tok-step-up');

describe('organizationsApi', () => {
  it('every call issues exactly one /api request', async () => {
    const { core, calls } = fakeCore();
    const api = organizationsApi(core);
    const names = Object.keys(api) as Array<keyof typeof api>;
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      const fn = api[name] as unknown as (...a: unknown[]) => Promise<unknown>;
      const before = calls.length;
      const args = Array.from({ length: Math.max(fn.length, 3) }, (_v, i) => argFor(i));
      // Object-shaped params get an object; the function body only forwards them.
      await fn(...args.map((a, i) => (i > 0 && fn.length > i ? { value: a } : a))).catch(() => undefined);
      const after = calls.length;
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

  it('the export reads the body as text, with no timeout (it streams)', async () => {
    const { core, calls } = fakeCore();
    await expect(organizationsApi(core).exportOrganization('org-1')).resolves.toBe('{"org":1}');
    expect(calls[0]).toMatchObject({ path: '/api/organization/org-1/export', init: { timeoutMs: null } });
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest } from '@jest/globals';
import { z } from 'zod';
import { callInternal, ContractRequestError, parseContractResponse, type ContractHttpClient } from '../src/contracts/call.js';
import {
  buildContractPath,
  contractErrorMessage,
  contractRoute,
  defineInternalEndpoint,
  isInternalConventionPath,
  parseContractBody,
  parseContractParams,
  parseContractQuery,
  pathParamNames,
} from '../src/contracts/define.js';
import { INTERNAL_CONTRACTS, internalContractsServedBy } from '../src/contracts/index.js';
import type { RouteTableEntry } from '../src/middleware/route-table.js';
import { findContractMountViolations, roundTripContractSample } from '../src/testing/internal-contracts.js';

const POST = defineInternalEndpoint({
  id: 'svc.thing',
  service: 'svc',
  method: 'POST',
  path: '/svc/internal/things/:orgId/:name',
  callers: ['a', 'b'],
  auth: 'service token',
  params: z.object({ orgId: z.string().min(1), name: z.string().min(1) }),
  body: z.object({ count: z.number({ error: 'count must be a number' }).int() }).strict(),
  response: z.object({ ok: z.boolean() }),
});

const GET = defineInternalEndpoint({
  id: 'svc.list',
  service: 'svc',
  method: 'GET',
  path: '/internal/list',
  callers: ['a'],
  auth: 'service token',
  params: z.object({}),
  query: z.object({ orgId: z.string().min(1) }),
  response: z.object({ names: z.array(z.string()) }),
});

const DEL = defineInternalEndpoint({
  id: 'svc.del',
  service: 'svc',
  method: 'DELETE',
  path: '/internal/x/:id',
  callers: ['a'],
  auth: '',
  params: z.object({ id: z.string() }),
  response: z.unknown(),
});
const PUT = defineInternalEndpoint({
  id: 'svc.put',
  service: 'svc',
  method: 'PUT',
  path: '/internal/x',
  callers: ['a'],
  auth: '',
  params: z.object({}),
  body: z.object({ v: z.string() }),
  response: z.object({ v: z.string() }),
});

type Fn = (...a: unknown[]) => Promise<unknown>;
function client(reply: unknown): ContractHttpClient & Record<'get' | 'post' | 'put' | 'delete', jest.Mock<Fn>> {
  const fn = () => jest.fn<Fn>().mockResolvedValue(reply);
  return { get: fn(), post: fn(), put: fn(), delete: fn() } as never;
}

describe('defineInternalEndpoint', () => {
  it('freezes the contract and its callers', () => {
    expect(Object.isFrozen(POST)).toBe(true);
    expect(Object.isFrozen(POST.callers)).toBe(true);
  });

  it('refuses a relative path or an empty caller list', () => {
    expect(() => defineInternalEndpoint({ ...GET, path: 'internal/list' })).toThrow(/must start with/);
    expect(() => defineInternalEndpoint({ ...GET, callers: [] })).toThrow(/names its callers/);
  });

  it('refuses a path outside the /internal convention, with no way to opt out', () => {
    expect(() => defineInternalEndpoint({ ...GET, path: '/svc/things' })).toThrow(/outside the \/internal convention/);
    expect(() => defineInternalEndpoint({ ...GET, path: '/svc/a/internal/things' })).toThrow(/outside the \/internal convention/);
    // The escape hatch is gone: an unknown key cannot smuggle a legacy path through.
    expect(() => defineInternalEndpoint({ ...GET, path: '/svc/things', outsideInternalPath: 'predates' } as never)).toThrow(/outside the \/internal convention/);
    expect(contractRoute(defineInternalEndpoint({ ...GET, path: '/svc/internal/things' }), '/svc/internal')).toBe('/things');
  });

  it('reads the convention as an `internal` FIRST or SECOND path segment, not a substring', () => {
    expect(isInternalConventionPath('/internal/x')).toBe(true);
    expect(isInternalConventionPath('/internal')).toBe(true);
    expect(isInternalConventionPath('/billing/internal/x')).toBe(true);
    expect(isInternalConventionPath('/x/internal')).toBe(true);
    expect(isInternalConventionPath('/Billing/INTERNAL/x')).toBe(true);
    expect(isInternalConventionPath('/a/b/internal/x')).toBe(false);
    expect(isInternalConventionPath('/reports/stakeholder-internal/x')).toBe(false);
    expect(isInternalConventionPath('/internals/x')).toBe(false);
  });
});

describe('paths', () => {
  it('lists the :params in order', () => {
    expect(pathParamNames(POST.path)).toEqual(['orgId', 'name']);
  });

  it('strips the mount prefix, and answers / for the mount itself', () => {
    expect(contractRoute(POST, '/svc')).toBe('/internal/things/:orgId/:name');
    expect(contractRoute(POST, '/svc/')).toBe('/internal/things/:orgId/:name');
    expect(contractRoute(GET, '/internal/list')).toBe('/');
    expect(contractRoute(GET)).toBe('/internal/list');
  });

  it('refuses a mount the contract is not under', () => {
    expect(() => contractRoute(POST, '/billing')).toThrow(/not under the mount/);
    expect(() => contractRoute(GET, '/internal/li')).toThrow(/not under the mount/);
  });

  it('encodes params and serializes the query, omitting undefined', () => {
    expect(buildContractPath(POST, { orgId: 'o/1', name: 'a b' })).toBe('/svc/internal/things/o%2F1/a%20b');
    expect(buildContractPath(GET, {}, { orgId: 'x', skip: undefined, n: 2, f: false })).toBe('/internal/list?orgId=x&n=2&f=false');
    expect(buildContractPath(GET, {}, { skip: undefined })).toBe('/internal/list');
    expect(buildContractPath(GET)).toBe('/internal/list');
  });

  it('refuses a missing or empty param', () => {
    expect(() => buildContractPath(POST, { orgId: 'o' })).toThrow(/missing path param 'name'/);
    expect(() => buildContractPath(POST, { orgId: '', name: 'n' })).toThrow(/missing path param 'orgId'/);
  });
});

describe('server-side parsing', () => {
  it('parses a body, reading an absent body as {}', () => {
    expect(parseContractBody(POST, { body: { count: 2 } })).toEqual({ ok: true, value: { count: 2 } });
    const missing = parseContractBody(POST, { body: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(contractErrorMessage(missing)).toBe('count must be a number');
  });

  it('accepts anything for a contract with no body schema', () => {
    expect(parseContractBody(GET, { body: { x: 1 } })).toEqual({ ok: true, value: undefined });
  });

  it('parses params and query', () => {
    expect(parseContractParams(POST, { params: { orgId: 'o', name: 'n' } } as never)).toEqual({ ok: true, value: { orgId: 'o', name: 'n' } });
    expect(parseContractParams(DEL, { params: undefined } as never).ok).toBe(false);
    expect(parseContractQuery(GET, { query: { orgId: 'o' } } as never)).toEqual({ ok: true, value: { orgId: 'o' } });
    expect(parseContractQuery(GET, { query: undefined } as never).ok).toBe(false);
    expect(parseContractQuery(POST, { query: { a: '1' } } as never)).toEqual({ ok: true, value: {} });
  });

  it('falls back to the summary when there is no zod error', () => {
    expect(contractErrorMessage({ error: 'Validation failed' })).toBe('Validation failed');
  });
});

describe('callInternal', () => {
  const headers = { 'x-a': '1' };

  it('POSTs the built path with the validated body and parses data', async () => {
    const c = client({ statusCode: 200, headers, body: { success: true, data: { ok: true, extra: 1 } } });
    const result = await callInternal(c, POST, { params: { orgId: 'o', name: 'n' }, body: { count: 1 }, options: { timeout: 5 } });
    expect(c.post).toHaveBeenCalledWith('/svc/internal/things/o/n', { count: 1 }, { timeout: 5 });
    expect(result).toEqual({ ok: true, status: 200, headers, data: { ok: true }, body: { success: true, data: { ok: true, extra: 1 } } });
  });

  it('GETs with the query, DELETEs and PUTs through their verbs', async () => {
    const g = client({ statusCode: 200, headers, body: { data: { names: ['a'] } } });
    await expect(callInternal(g, GET, { query: { orgId: 'o' } })).resolves.toMatchObject({ ok: true, data: { names: ['a'] } });
    expect(g.get).toHaveBeenCalledWith('/internal/list?orgId=o', undefined);

    const d = client({ statusCode: 204, headers, body: {} });
    await expect(callInternal(d, DEL, { params: { id: '1' } })).resolves.toMatchObject({ ok: true, status: 204 });
    expect(d.delete).toHaveBeenCalledWith('/internal/x/1', undefined);

    const p = client({ statusCode: 200, headers, body: { data: { v: 'x' } } });
    await expect(callInternal(p, PUT, { body: { v: 'x' } })).resolves.toMatchObject({ ok: true, data: { v: 'x' } });
    expect(p.put).toHaveBeenCalledWith('/internal/x', { v: 'x' }, undefined);
  });

  it('reports a non-2xx as a status failure with its body', async () => {
    const c = client({ statusCode: 409, headers, body: { message: 'no' } });
    await expect(callInternal(c, GET, { query: { orgId: 'o' } }))
      .resolves.toEqual({ ok: false, reason: 'status', status: 409, headers, body: { message: 'no' } });
    const r = client({ statusCode: 302, headers, body: {} });
    await expect(callInternal(r, GET, { query: { orgId: 'o' } })).resolves.toMatchObject({ ok: false, reason: 'status', status: 302 });
  });

  it('reports a 2xx whose data does not match as invalid-response', async () => {
    const c = client({ statusCode: 200, headers, body: { names: ['bare body, no envelope'] } });
    const result = await callInternal(c, GET, { query: { orgId: 'o' } });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-response', status: 200 });
  });

  it('reports a safe client\'s null as unreachable', async () => {
    await expect(callInternal(client(null), GET, { query: { orgId: 'o' } })).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  it('throws ContractRequestError for a bad body or missing param, sending nothing', async () => {
    const c = client({ statusCode: 200, headers, body: {} });
    await expect(callInternal(c, POST, { params: { orgId: 'o', name: 'n' }, body: { count: 'x' } as never })).rejects.toBeInstanceOf(ContractRequestError);
    await expect(callInternal(c, POST, { params: { orgId: 'o' }, body: { count: 1 } })).rejects.toThrow(/svc\.thing.*missing path param/);
    await expect(callInternal(c, PUT)).rejects.toMatchObject({ code: 'CONTRACT_REQUEST_INVALID', contractId: 'svc.put' });
    expect(c.post).not.toHaveBeenCalled();
    expect(c.put).not.toHaveBeenCalled();
  });

  it('propagates a transport error from the client', async () => {
    const c = client(null);
    c.get.mockRejectedValue(new Error('timeout'));
    await expect(callInternal(c, GET, { query: { orgId: 'o' } })).rejects.toThrow('timeout');
  });

  it('parseContractResponse reads only the envelope data', () => {
    expect(parseContractResponse(GET, { data: { names: [] } })).toEqual({ ok: true, value: { names: [] } });
    expect(parseContractResponse(GET, null).ok).toBe(false);
    expect(parseContractResponse(GET, 'text').ok).toBe(false);
  });
});

describe('contract test helpers', () => {
  const entry = (over: Partial<RouteTableEntry> = {}): RouteTableEntry => ({
    method: 'POST', path: POST.path, auth: true, internalCallers: ['b', 'a'], ...over,
  } as RouteTableEntry);

  it('passes a route mounted as declared', () => {
    expect(findContractMountViolations([entry()], POST)).toEqual([]);
  });

  it('names a missing route, and the methods its path does serve', () => {
    expect(findContractMountViolations([], POST)[0]).toMatch(/no route mounted/);
    expect(findContractMountViolations([entry({ method: 'GET' })], POST)[0]).toMatch(/the path serves GET/);
  });

  it('names a missing requireAuth and drifted callers', () => {
    const v = findContractMountViolations([entry({ auth: false, internalCallers: ['a'] })], POST);
    expect(v).toHaveLength(2);
    expect(v[1]).toMatch(/callers are \[a\] but the contract names \[a, b\]/);
  });

  it('round-trips a valid sample', () => {
    const out = roundTripContractSample(POST, { params: { orgId: 'o', name: 'n' }, body: { count: 1 }, response: { ok: true } });
    expect(out.path).toBe('/svc/internal/things/o/n');
    expect(roundTripContractSample(GET, { query: { orgId: 'o' }, response: { names: ['x'] } }).path).toBe('/internal/list?orgId=o');
  });

  it.each([
    ['a missing param', POST, { params: { orgId: 'o' }, body: { count: 1 }, response: { ok: true } }, /omits name/],
    ['a bad body', POST, { params: { orgId: 'o', name: 'n' }, body: { count: 'x' }, response: { ok: true } }, /body/],
    ['a body with no schema', GET, { query: { orgId: 'o' }, body: { x: 1 }, response: { names: [] } }, /no schema/],
    ['a query with no schema', POST, { params: { orgId: 'o', name: 'n' }, query: { a: 'b' }, body: { count: 1 }, response: { ok: true } }, /reads no query/],
    ['a bad response', GET, { query: { orgId: 'o' }, response: { names: [1] } }, /response/],
  ] as const)('throws for %s', (_what, contract, sample, msg) => {
    expect(() => roundTripContractSample(contract, sample as never)).toThrow(msg);
  });

  it('throws when a value does not survive JSON', () => {
    const dated = defineInternalEndpoint({ ...GET, id: 'svc.dated', response: z.object({ at: z.date() }) });
    expect(() => roundTripContractSample(dated, { query: { orgId: 'o' }, response: { at: new Date(0) } })).toThrow(/after JSON/);
    const lossy = defineInternalEndpoint({ ...GET, id: 'svc.lossy', response: z.object({ n: z.number() }) });
    expect(() => roundTripContractSample(lossy, { query: { orgId: 'o' }, response: { n: Number.NaN } })).toThrow();
  });
});

describe('the contract registry', () => {
  it('has unique ids and unique method + path per service', () => {
    const ids = INTERNAL_CONTRACTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = INTERNAL_CONTRACTS.map((c) => `${c.service} ${c.method} ${c.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('names every contract after the service that serves it', () => {
    for (const c of INTERNAL_CONTRACTS) expect(c.id.startsWith(`${c.service}.`)).toBe(true);
  });

  // ONE rule covers every internal contract: the gateway refuses an `internal`
  // first or second segment (deploy/*/nginx/nginx.conf; pinned for all four
  // targets by test/deploy-contracts internal-gateway-contract.test.ts), so a
  // contract served anywhere else would be reachable from outside.
  it('serves EVERY contract under /internal — `/internal/…` or `/<service-prefix>/internal/…`', () => {
    const outside = INTERNAL_CONTRACTS.filter((c) => !/^\/(?:[^/]+\/)?internal\//.test(c.path))
      .map((c) => `${c.id} ${c.method} ${c.path}`);
    expect(outside).toEqual([]);
    expect(INTERNAL_CONTRACTS.some((c) => 'outsideInternalPath' in c)).toBe(false);
  });

  it('puts every contract behind the gateway\'s refusal once it carries the /api prefix', () => {
    // The same pattern as the nginx `location ~* ^/api/(?:[^/]+/)?internal(?:/|$)`.
    const GATEWAY_REFUSES = /^\/api\/(?:[^/]+\/)?internal(?:\/|$)/i;
    for (const c of INTERNAL_CONTRACTS) {
      // nginx maps `/api/<prefix>/…` onto the service's `/<prefix>/…` (the
      // prefix's spelling may differ, e.g. /api/quota → /quotas, but it is
      // ONE segment either way), so the internal segment keeps its position.
      expect(`/api${c.path}`).toMatch(GATEWAY_REFUSES);
    }
  });

  it('filters by serving service', () => {
    expect(internalContractsServedBy('billing').map((c) => c.id)).toEqual(['billing.consumeSupportIncident', 'billing.refundSupportIncident', 'billing.purgeOrg']);
    expect(internalContractsServedBy('nobody')).toEqual([]);
  });
});

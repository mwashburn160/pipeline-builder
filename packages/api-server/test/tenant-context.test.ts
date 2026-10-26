// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Capture the tenant scope handed to runWithTenantContext so we can assert the
// default `identityScope` resolver reads the CALLER's (already-normalized) org.
const capturedScopes: Array<Record<string, unknown>> = [];
// Spread the real module rather than listing exports: the module under test also
// imports `getTenantContext` (to feed the logger's org context), and an explicit
// allow-list silently breaks the suite every time a new export is used. Same
// rationale as `apiCoreMock` — see helpers/mock-api-core.ts.
const actualPipelineData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...actualPipelineData,
  runWithTenantContext: (scope: Record<string, unknown>, cb: () => unknown) => {
    capturedScopes.push(scope);
    return cb();
  },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // isSystemAdmin reads the verified super-admin claim off req.user.
  isSystemAdmin: (req: { user?: { isSuperAdmin?: boolean } }) => req.user?.isSuperAdmin === true,
}));

const { withTenantContext } = await import('../src/api/tenant-context.js');
const { setWritePinStore, NO_WRITE_PIN } = await import('../src/api/write-pin.js');

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    // getContext reads req.context; identity.orgId is normalized upstream.
    context: { identity: { orgId: 'acme' } },
    user: {},
    ...overrides,
  };
}

describe('withTenantContext (identityScope)', () => {
  beforeEach(() => {
    capturedScopes.length = 0;
  });

  it('opens the RLS scope on the caller identity org (normalized) and calls next', () => {
    const req = mockReq({
      context: { identity: { orgId: 'acme' } },
      user: { parentOrganizationId: 'parent-org' },
    });
    const next = jest.fn();
    withTenantContext()(req, {} as any, next);

    expect(capturedScopes).toHaveLength(1);
    expect(capturedScopes[0]).toEqual({
      orgId: 'acme',
      isSuperAdmin: false,
      parentOrgId: 'parent-org',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets isSuperAdmin from the verified super-admin claim', () => {
    const req = mockReq({
      context: { identity: { orgId: 'acme' } },
      user: { isSuperAdmin: true },
    });
    const next = jest.fn();
    withTenantContext()(req, {} as any, next);

    expect(capturedScopes[0].isSuperAdmin).toBe(true);
  });

  it('hard-FAILS the request (500 via next(err)) when the resolver throws', () => {
    const boom = new Error('scope resolution failed');
    const throwingResolver = () => { throw boom; };
    const req = mockReq();
    const next = jest.fn();

    withTenantContext(throwingResolver)(req, {} as any, next);

    // The scope was never opened and the error is forwarded to the error handler.
    expect(capturedScopes).toHaveLength(0);
    expect(next).toHaveBeenCalledWith(boom);
  });
});

/**
 * The cross-request write pin (src/api/write-pin.ts).
 *
 * The cases above are the SHIPPING configuration — no replica — and they pass
 * with a bare `{}` as the response, which is the point: with the pin inactive
 * the middleware registers no response listener, touches no Redis, and calls
 * `next()` synchronously, exactly as it did before the pin existed. A feature
 * nobody has enabled must not make the request path asynchronous for every
 * route on every target, and those tests failing on `res.on is not a function`
 * is what caught the first attempt doing precisely that.
 */
describe('withTenantContext — write pin', () => {
  const ENV = ['DB_READ_HOST', 'DB_READ_ENABLED'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    capturedScopes.length = 0;
    for (const k of ENV) saved[k] = process.env[k];
    setWritePinStore(NO_WRITE_PIN);
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setWritePinStore(undefined);
  });

  it('touches neither the response nor next asynchronously while inactive', () => {
    delete process.env.DB_READ_HOST;
    const next = jest.fn();
    const res = { on: jest.fn() };
    withTenantContext()(mockReq(), res as any, next);
    // Synchronous, and no `finish` listener at all — not merely a listener that
    // does nothing.
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.on).not.toHaveBeenCalled();
  });

  it('registers the finish listener and defers next once a replica is configured', async () => {
    process.env.DB_READ_HOST = 'pgbouncer';
    delete process.env.DB_READ_ENABLED;
    const next = jest.fn();
    const res = { on: jest.fn() };
    withTenantContext()(mockReq(), res as any, next);

    // next() is now deferred by a microtask: the pin has to be consulted before
    // the request can know whether it may read a replica.
    expect(next).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  it('marks the request as written when the org is pinned', async () => {
    process.env.DB_READ_HOST = 'pgbouncer';
    setWritePinStore({ isPinned: () => Promise.resolve(true), pin: () => Promise.resolve() });
    const next = jest.fn();
    withTenantContext()(mockReq(), { on: jest.fn() } as any, next);
    await Promise.resolve();
    await Promise.resolve();
    // The pin sets the SAME flag withTenantTx sets, so the read helper keeps
    // this request on the primary — one mechanism, not two.
    expect(capturedScopes[0].mayHaveWritten).toBe(true);
  });

  it('leaves the request unmarked when the org is not pinned', async () => {
    process.env.DB_READ_HOST = 'pgbouncer';
    setWritePinStore({ isPinned: () => Promise.resolve(false), pin: () => Promise.resolve() });
    const next = jest.fn();
    withTenantContext()(mockReq(), { on: jest.fn() } as any, next);
    await Promise.resolve();
    await Promise.resolve();
    // If this came back true, every read would route to the primary and the
    // feature would be inert with none of the cost removed.
    expect(capturedScopes[0].mayHaveWritten).toBeUndefined();
  });

  it('fails CLOSED when the pin lookup rejects', async () => {
    process.env.DB_READ_HOST = 'pgbouncer';
    setWritePinStore({
      isPinned: () => Promise.reject(new Error('redis down')),
      pin: () => Promise.resolve(),
    });
    const next = jest.fn();
    withTenantContext()(mockReq(), { on: jest.fn() } as any, next);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Unknown must mean "assume written": serving a possibly-stale read is the
    // failure this whole mechanism exists to prevent, and the request must
    // still proceed rather than 500.
    expect(capturedScopes[0].mayHaveWritten).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
  });
});

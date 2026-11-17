// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `serviceOrUserGates` — the per-caller-kind branch on the billing-facing
 * `/organization/:id/seat-limit` (and seat/support-usage, feature-entitlements)
 * routes, composed with the REAL api-core gates:
 *   - a service token runs `requireInternalService({ callers: ['billing'] })`,
 *     so any service but billing is refused;
 *   - a user runs the user chain (for seat-limit: system org + `orgs:manage`,
 *     then a step-up), and never the service chain.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { requireInternalService } = await import('@pipeline-builder/api-core');
const { serviceOrUserGates } = await import('../src/middleware/service-or-user-gates.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const billing = { sub: 'service:billing', principalType: 'service' };
const plugin = { sub: 'service:plugin', principalType: 'service' };
const person = { sub: 'u1', principalType: 'user', permissions: [] };

const run = async (gate: ReturnType<typeof serviceOrUserGates>, user: unknown) => {
  const res = mockRes();
  const next = jest.fn();
  gate({ user, method: 'PUT', url: '/organization/o1/seat-limit', originalUrl: '/organization/o1/seat-limit', headers: {} } as any, res, next);
  await new Promise((r) => setImmediate(r));
  return { res, next };
};

describe('serviceOrUserGates', () => {
  const userGate = jest.fn((_req: unknown, res: any) => { res.status(403).json({ from: 'user-chain' }); });
  const gate = serviceOrUserGates([requireInternalService({ callers: ['billing'] })], [userGate as any]);

  it('admits the billing service without touching the user chain', async () => {
    userGate.mockClear();
    const { res, next } = await run(gate, billing);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(userGate).not.toHaveBeenCalled();
  });

  it('refuses any other service (the bare isServicePrincipal check admitted it)', async () => {
    const { res, next } = await run(gate, plugin);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(userGate).not.toHaveBeenCalled();
  });

  it('runs the USER chain for a person — the service allowlist is not a way in', async () => {
    userGate.mockClear();
    const { res, next } = await run(gate, person);
    expect(userGate).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ from: 'user-chain' });
  });

  it('passes straight through for a person when the user chain is empty (controller decides)', async () => {
    const readGate = serviceOrUserGates([requireInternalService({ callers: ['billing'] })], []);
    const { next } = await run(readGate, person);
    expect(next).toHaveBeenCalledWith();
  });

  it('runs every user gate in order and stops at the first refusal', async () => {
    const order: string[] = [];
    const pass = (name: string) => (_q: unknown, _r: unknown, n: () => void) => { order.push(name); n(); };
    const stop = (_q: unknown, r: any) => { order.push('stop'); r.status(401).json({}); };
    const chain = serviceOrUserGates([requireInternalService({ callers: ['billing'] })], [pass('a') as any, stop as any, pass('b') as any]);
    await run(chain, person);
    expect(order).toEqual(['a', 'stop']);
  });

  it('refuses to build with an empty service chain (it would admit every service)', () => {
    expect(() => serviceOrUserGates([], [])).toThrow();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Device-authorization route wiring. Approving a device code mints a full
 * INTERACTIVE session for the CLI, so the approval must come from a person's own
 * interactive session — never an exchanged access key, a scoped credential or an
 * impersonation, any of which `requireAuth` alone accepts — and must carry a
 * fresh step-up.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { routeChain } from './helpers/route-chain.js';

const tagged = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { __mw: name });

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  requireStepUp: tagged('requireStepUp'),
  audited: (...actions: string[]) => tagged(`audited:${actions.join(',')}`),
}));
jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireAuth: tagged('requireAuth'),
  requireInteractiveSession: tagged('requireInteractiveSession'),
}));
jest.unstable_mockModule('../src/middleware/rate-limiter.js', () => ({
  createLimiter: (opts: { name: string }) => tagged(`limiter:${opts.name}`),
  userOrIpKey: () => 'k',
}));
jest.unstable_mockModule('../src/middleware/rate-limit-keys.js', () => ({ extractClientIp: () => 'ip' }));
jest.unstable_mockModule('../src/controllers/device-auth.js', () => ({
  approveDeviceRequest: tagged('approveDeviceRequest'),
  denyDeviceRequest: tagged('denyDeviceRequest'),
  deviceToken: tagged('deviceToken'),
  getDeviceRequest: tagged('getDeviceRequest'),
  startDeviceCode: tagged('startDeviceCode'),
}));

const { default: router } = await import('../src/routes/device-auth.js');

describe('POST /auth/device/approve', () => {
  it('requires the person\'s own interactive session, then a step-up', () => {
    const mw = routeChain(router, 'post', '/approve');
    expect(mw).toContain('requireInteractiveSession');
    expect(mw.indexOf('requireInteractiveSession')).toBeGreaterThan(mw.indexOf('requireAuth'));
    expect(mw.indexOf('requireStepUp')).toBeGreaterThan(mw.indexOf('requireInteractiveSession'));
    expect(mw.at(-1)).toBe('approveDeviceRequest');
  });

  it('leaves deny open to any signed-in session (refusing is the safe direction)', () => {
    expect(routeChain(router, 'post', '/deny')).not.toContain('requireInteractiveSession');
  });
});

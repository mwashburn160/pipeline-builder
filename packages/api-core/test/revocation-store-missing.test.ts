// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "revocation store NOT registered" warning must fire on the path every
 * request takes (`requireAuth` → `needsRevocationCheck`), not only on the
 * out-of-band `isAccessTokenRevoked` path: with no store registered
 * `requireAuth` never reaches `isTokenRevoked`, so a warning that lived only
 * there was never logged by any service that forgot to wire the store.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const warn = jest.fn();
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn, error: jest.fn(), debug: jest.fn() }),
}));

const { needsRevocationCheck, setTokenRevocationStore } = await import('../src/middleware/revocation.js');

const revocable = { sub: 'user1', tokenVersion: 3 } as Parameters<typeof needsRevocationCheck>[0];

describe('revocation store missing', () => {
  beforeEach(() => {
    warn.mockClear();
    // Registering then clearing re-arms the one-shot warning.
    setTokenRevocationStore({ getCurrentVersion: async () => null });
    setTokenRevocationStore(undefined);
  });

  it('warns once on the requireAuth path when a revocable user token arrives', () => {
    expect(needsRevocationCheck(revocable)).toBe(false);
    expect(needsRevocationCheck(revocable)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/NOT registered/);
  });

  it('stays quiet for a token with nothing to revoke', () => {
    needsRevocationCheck({ sub: 'service:billing' } as Parameters<typeof needsRevocationCheck>[0]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet once a store is registered', () => {
    setTokenRevocationStore({ getCurrentVersion: async () => null });
    expect(needsRevocationCheck(revocable)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    setTokenRevocationStore(undefined);
  });
});

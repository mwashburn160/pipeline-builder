// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from '@testing-library/react';
import {
  usePendingMarketplaceClaim,
  stashMarketplaceRef,
  readMarketplaceRef,
  clearMarketplaceRef,
} from '../src/hooks/usePendingMarketplaceClaim';

const claim = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { claimMarketplaceRegistration: (...a: unknown[]) => claim(...a) },
}));

const success = jest.fn();
const error = jest.fn();
jest.mock('@/components/ui/Toast', () => ({ useToast: () => ({ success, error }) }));

let authState = { isAuthenticated: true, isInitialized: true };
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => authState }));

beforeEach(() => {
  jest.clearAllMocks();
  authState = { isAuthenticated: true, isInitialized: true };
  clearMarketplaceRef();
});

describe('marketplace ref storage helpers', () => {
  it('stashes and reads back a ref (sessionStorage)', () => {
    expect(stashMarketplaceRef('ref-1', 'Team')).toBe(true);
    expect(readMarketplaceRef()).toEqual({ registrationRef: 'ref-1', planName: 'Team' });
  });

  it('falls back to the cookie when sessionStorage is unavailable', () => {
    const orig = window.sessionStorage;
    // Simulate a storage-blocked browser: getItem/setItem throw.
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } },
    });
    try {
      expect(stashMarketplaceRef('ref-cookie', 'Pro')).toBe(true); // cookie write still succeeds
      expect(readMarketplaceRef()).toEqual({ registrationRef: 'ref-cookie', planName: 'Pro' });
    } finally {
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: orig });
    }
  });

  it('clear removes the ref from both channels', () => {
    stashMarketplaceRef('ref-1', null);
    clearMarketplaceRef();
    expect(readMarketplaceRef()).toBeNull();
  });
});

describe('usePendingMarketplaceClaim', () => {
  it('does nothing when there is no stashed ref', async () => {
    renderHook(() => usePendingMarketplaceClaim());
    await waitFor(() => expect(claim).not.toHaveBeenCalled());
  });

  it('does nothing until auth is initialized + authenticated', async () => {
    authState = { isAuthenticated: false, isInitialized: true };
    stashMarketplaceRef('ref-1', 'Team');
    renderHook(() => usePendingMarketplaceClaim());
    await waitFor(() => expect(claim).not.toHaveBeenCalled());
    expect(readMarketplaceRef()).not.toBeNull(); // still stashed for a later signed-in visit
  });

  it('claims a stashed ref, clears it, and toasts success', async () => {
    claim.mockResolvedValue({ success: true });
    stashMarketplaceRef('ref-1', 'Team');
    renderHook(() => usePendingMarketplaceClaim());
    await waitFor(() => expect(claim).toHaveBeenCalledWith('ref-1'));
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(readMarketplaceRef()).toBeNull(); // consumed
  });

  it('clears the ref on a DEFINITIVE server rejection (no retry loop)', async () => {
    claim.mockResolvedValue({ success: false, message: 'already linked' });
    stashMarketplaceRef('ref-1', 'Team');
    renderHook(() => usePendingMarketplaceClaim());
    await waitFor(() => expect(error).toHaveBeenCalledWith('already linked'));
    expect(readMarketplaceRef()).toBeNull();
  });

  it('KEEPS the ref on a transient failure so a later visit retries', async () => {
    claim.mockRejectedValue(new Error('network'));
    stashMarketplaceRef('ref-1', 'Team');
    renderHook(() => usePendingMarketplaceClaim());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(readMarketplaceRef()).toEqual({ registrationRef: 'ref-1', planName: 'Team' });
  });
});

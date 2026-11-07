// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The provider catalog and the guard built on it.
 *
 * `isOAuthProviderName` exists to delete casts, so what matters is that it
 * actually rejects — a guard that returned true for everything would typecheck
 * every call site it was introduced to fix while restoring the exact bug those
 * casts had: an unknown provider name resolving to `undefined` at runtime.
 */

import { describe, it, expect } from '@jest/globals';
import {
  isOAuthProviderName,
  OAUTH_PROVIDER_NAMES,
  type OAuthProviderName,
} from '../src/types/oauth-provider.js';

describe('the provider catalog', () => {
  it('lists the six wired providers', () => {
    // Pinned against the union: the runtime tuple and the type are two
    // declarations of one list, and only a test can hold them together.
    expect([...OAUTH_PROVIDER_NAMES].sort()).toEqual(
      ['facebook', 'github', 'gitlab', 'google', 'linkedin', 'microsoft'],
    );
  });

  it('has no duplicates, which would double-count an enabled provider', () => {
    expect(new Set(OAUTH_PROVIDER_NAMES).size).toBe(OAUTH_PROVIDER_NAMES.length);
  });
});

describe('isOAuthProviderName', () => {
  it.each([...OAUTH_PROVIDER_NAMES])('accepts %s', (name) => {
    expect(isOAuthProviderName(name)).toBe(true);
  });

  it.each([
    ['generic-oidc', 'deliberately NOT in the union — it is the IdP-config flow'],
    ['Google', 'case matters; the registry keys are lower-case'],
    ['googl', 'a typo, which the old `name as OAuthProviderName` cast accepted'],
    ['', 'empty'],
    ['__proto__', 'a key that would otherwise find something on the prototype'],
  ])('rejects %s (%s)', (name) => {
    expect(isOAuthProviderName(name)).toBe(false);
  });

  it('narrows, so a lookup keyed by the result needs no cast', () => {
    // The compile-time half of the point, exercised at runtime: inside the
    // guard the value indexes a Record keyed by the union.
    const registry: Record<OAuthProviderName, number> = {
      google: 1, github: 2, facebook: 3, microsoft: 4, gitlab: 5, linkedin: 6,
    };
    const name: string = 'gitlab';
    expect(isOAuthProviderName(name) ? registry[name] : null).toBe(5);
  });
});

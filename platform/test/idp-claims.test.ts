// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Group-claim extraction (helpers/idp-claims.ts).
 *
 * This is the boundary where an id_token stops being the IdP's word and becomes
 * a list the mapping engine acts on, so the tests are about what it REFUSES to
 * turn into a group as much as what it accepts.
 */

import { describe, it, expect } from '@jest/globals';
import { DEFAULT_GROUPS_CLAIM, extractGroupClaim, groupKey, providerSupportsGroups } from '../src/helpers/idp-claims.js';

describe('extractGroupClaim', () => {
  it('reads an array claim under the DEFAULT name when none is configured', () => {
    expect(extractGroupClaim({ groups: ['eng', 'sre'] })).toEqual(['eng', 'sre']);
    expect(DEFAULT_GROUPS_CLAIM).toBe('groups');
  });

  it('reads a per-IdP claim name (Cognito emits cognito:groups)', () => {
    const claims = { 'groups': ['ignored'], 'cognito:groups': ['admins'] };
    expect(extractGroupClaim(claims, 'cognito:groups')).toEqual(['admins']);
  });

  it('accepts a space- or comma-separated STRING claim', () => {
    expect(extractGroupClaim({ groups: 'eng sre' })).toEqual(['eng', 'sre']);
    expect(extractGroupClaim({ groups: 'eng, sre' })).toEqual(['eng', 'sre']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(extractGroupClaim({ groups: ['Eng', 'eng', 'ENG'] })).toEqual(['Eng']);
  });

  it('drops non-string, blank and over-long entries instead of coercing them', () => {
    const claims = { groups: ['eng', 42, null, { nested: true }, '   ', 'x'.repeat(300)] };
    expect(extractGroupClaim(claims)).toEqual(['eng']);
  });

  it('yields NO groups for a claim shape it would have to guess at', () => {
    expect(extractGroupClaim({ groups: 42 })).toEqual([]);
    expect(extractGroupClaim({ groups: { a: 1 } })).toEqual([]);
    expect(extractGroupClaim({})).toEqual([]);
    expect(extractGroupClaim(null)).toEqual([]);
  });

  it('caps the number of groups it will carry', () => {
    const many = Array.from({ length: 250 }, (_, i) => `g${i}`);
    expect(extractGroupClaim({ groups: many })).toHaveLength(100);
  });

  it('falls back to the default claim name when the configured one is blank', () => {
    expect(extractGroupClaim({ groups: ['eng'] }, '   ')).toEqual(['eng']);
  });
});

describe('groupKey', () => {
  it('trims and lowercases, so an IdP\'s casing can\'t fork a mapping', () => {
    expect(groupKey('  Platform-Engineers ')).toBe('platform-engineers');
  });
});

describe('providerSupportsGroups', () => {
  it('refuses Google (its OIDC tokens carry no group claim) and GitHub (not OIDC)', () => {
    expect(providerSupportsGroups('google')).toBe(false);
    expect(providerSupportsGroups('github')).toBe(false);
  });

  it('allows the providers that do emit groups', () => {
    expect(providerSupportsGroups('generic-oidc')).toBe(true);
    expect(providerSupportsGroups('cognito')).toBe(true);
  });
});

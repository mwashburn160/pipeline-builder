// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  getPrimarySupportAlias,
  getAllSupportAliases,
  resolveRecipientAlias,
  resetSupportAliasesCache,
  DEFAULT_SUPPORT_ALIAS,
} from '../src/utils/alias-resolver.js';
import { envInt, envBool, envStr, envEnum } from '../src/utils/env.js';

const ENV_KEYS = ['T_INT', 'T_BOOL', 'T_STR', 'T_ENUM', 'SUPPORT_ALIASES'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetSupportAliasesCache();
});

describe('envInt', () => {
  it('parses a valid int', () => { process.env.T_INT = '42'; expect(envInt('T_INT', 7)).toBe(42); });
  it('falls back on unset', () => { expect(envInt('T_INT', 7)).toBe(7); });
  it('falls back on non-numeric', () => { process.env.T_INT = 'abc'; expect(envInt('T_INT', 7)).toBe(7); });
  it('clamps to min', () => { process.env.T_INT = '0'; expect(envInt('T_INT', 7, { min: 1 })).toBe(1); });
  it('clamps to max', () => { process.env.T_INT = '9999'; expect(envInt('T_INT', 7, { max: 100 })).toBe(100); });
});

describe('envBool', () => {
  it.each([['true', true], ['false', false], ['1', true], ['0', false], ['TRUE', true]])('parses %s', (v, exp) => {
    process.env.T_BOOL = v as string; expect(envBool('T_BOOL', !exp)).toBe(exp);
  });
  it('falls back on unset', () => { expect(envBool('T_BOOL', true)).toBe(true); });
});

describe('envStr', () => {
  it('returns the value', () => { process.env.T_STR = 'hi'; expect(envStr('T_STR', 'def')).toBe('hi'); });
  it('falls back on unset/empty', () => { expect(envStr('T_STR', 'def')).toBe('def'); });
});

describe('envEnum', () => {
  it('accepts a member', () => { process.env.T_ENUM = 'b'; expect(envEnum('T_ENUM', ['a', 'b', 'c'] as const, 'a')).toBe('b'); });
  it('falls back on non-member', () => { process.env.T_ENUM = 'z'; expect(envEnum('T_ENUM', ['a', 'b'] as const, 'a')).toBe('a'); });
});

describe('support alias resolver', () => {
  it('primary + all reflect SUPPORT_ALIASES (order preserved)', () => {
    process.env.SUPPORT_ALIASES = 'support@x, help@x';
    resetSupportAliasesCache();
    expect(getPrimarySupportAlias()).toBe('support@x');
    expect(getAllSupportAliases()).toEqual(['support@x', 'help@x']);
  });
  it('falls back to the default when unset', () => {
    resetSupportAliasesCache();
    expect(getPrimarySupportAlias()).toBe(DEFAULT_SUPPORT_ALIAS);
    expect(getAllSupportAliases()).toEqual([DEFAULT_SUPPORT_ALIAS]);
  });
  it('resolves any configured alias to the system org', () => {
    process.env.SUPPORT_ALIASES = 'support@x,help@x';
    resetSupportAliasesCache();
    const r = resolveRecipientAlias('help@x');
    expect(r.wasAlias).toBe(true);
    expect(r.resolvedOrgId).not.toBe('help@x');
  });
  it('passes a non-alias recipient through unchanged', () => {
    process.env.SUPPORT_ALIASES = 'support@x';
    resetSupportAliasesCache();
    const r = resolveRecipientAlias('org-123');
    expect(r.wasAlias).toBe(false);
    expect(r.resolvedOrgId).toBe('org-123');
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/plugin-catalog-metadata — the ONE validator a detected
 * catalog value and a user-typed one both pass,
 * and the execution-contract refusal.
 */

import { describe, it, expect } from '@jest/globals';
import { PLUGIN_CATALOG_FIELDS } from '../src/types/plugin-catalog.js';
import {
  ICON_KEY_PATTERN, PLUGIN_CONTRACT_FIELDS, PluginCatalogEditsSchema,
  contractKeysMessage, findContractKeys, isAllowedSpdxId, projectUrlProblem, validateCatalogField,
} from '../src/validation/plugin-catalog-metadata.js';

describe('isAllowedSpdxId', () => {
  it.each(['Apache-2.0', 'MIT', 'GPL-3.0-or-later', 'LicenseRef-Proprietary'])('accepts %s', (id) => {
    expect(isAllowedSpdxId(id)).toBe(true);
  });

  it.each(['apache-2.0', 'GPL-3.0', 'WTFPL', '', 'MIT OR Apache-2.0'])('refuses %p (case-sensitive, allowlist only)', (id) => {
    expect(isAllowedSpdxId(id)).toBe(false);
  });
});

describe('projectUrlProblem', () => {
  it.each(['https://github.com/acme/plugin', 'https://docs.acme.io/x?y=1#z'])('accepts %s', (url) => {
    expect(projectUrlProblem(url)).toBeNull();
  });

  it.each([
    ['http://acme.io', /https/],
    ['ftp://acme.io', /https/],
    ['javascript:alert(1)', /https/],
    ['not a url', /absolute URL/],
    ['https://user:pw@acme.io', /credentials/],
    ['https://token@acme.io', /credentials/],
    ['https://bit.ly/abc', /shortener \(bit\.ly\)/],
    ['https://BIT.LY./abc', /shortener/],
    ['https://go.tinyurl.com/abc', /shortener/],
    [`https://acme.io/${'a'.repeat(2048)}`, /2048/],
  ])('refuses %s', (url, reason) => {
    expect(projectUrlProblem(url)).toMatch(reason);
  });

  it('does not mistake a host that merely contains a shortener name', () => {
    expect(projectUrlProblem('https://notbit.ly.example.com/x')).toBeNull();
  });
});

describe('ICON_KEY_PATTERN', () => {
  it('matches curated file names only', () => {
    expect(ICON_KEY_PATTERN.test('aws-codebuild')).toBe(true);
    expect(ICON_KEY_PATTERN.test('../evil')).toBe(false);
    expect(ICON_KEY_PATTERN.test('Trivy')).toBe(false);
  });
});

describe('validateCatalogField', () => {
  it('normalizes accepted values (trimmed text, icon key → { key })', () => {
    expect(validateCatalogField('summary', '  One line.  ')).toEqual({ ok: true, value: 'One line.' });
    expect(validateCatalogField('icon', 'trivy')).toEqual({ ok: true, value: { key: 'trivy' } });
    expect(validateCatalogField('icon', { key: 'snyk', badge: 'python' })).toEqual({ ok: true, value: { key: 'snyk', badge: 'python' } });
    expect(validateCatalogField('keywords', ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
    expect(validateCatalogField('category', 'security')).toEqual({ ok: true, value: 'security' });
  });

  it.each([
    ['summary', 'x'.repeat(161), /160/],
    ['summary', '   ', /empty/],
    ['description', 'x'.repeat(2001), /2000/],
    ['displayName', 'x'.repeat(101), /100/],
    ['category', 'build', /one of/],
    ['keywords', Array.from({ length: 11 }, (_, i) => `k${i}`), /at most 10/],
    ['keywords', ['x'.repeat(33)], /32/],
    ['license', 'MIT OR Apache-2.0', /SPDX/],
    ['homepageUrl', 'http://acme.io', /https/],
    ['documentationUrl', 'https://bit.ly/x', /shortener/],
    ['icon', 'Bad Key', /\^\[a-z0-9-\]\+\$/],
    ['changelog', 'é'.repeat(20 * 1024), /bytes/],
    ['readme', 'x'.repeat(64 * 1024 + 1), /bytes/],
  ] as const)('refuses %s = … with the reason', (field, value, reason) => {
    const r = validateCatalogField(field, value);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(reason);
  });
});

describe('PluginCatalogEditsSchema', () => {
  it('accepts any subset of descriptive fields, null clearing one', () => {
    expect(PluginCatalogEditsSchema.safeParse({ summary: 'x', homepageUrl: null, icon: 'trivy' }).success).toBe(true);
  });

  it('is strict: an unknown key is an error, not silently dropped', () => {
    expect(PluginCatalogEditsSchema.safeParse({ summary: 'x', surprise: 1 }).success).toBe(false);
  });

  it('covers exactly the descriptive fields', () => {
    expect(Object.keys(PluginCatalogEditsSchema.shape).sort()).toEqual([...PLUGIN_CATALOG_FIELDS].sort());
  });
});

describe('findContractKeys / contractKeysMessage', () => {
  it('names every execution-contract key present, in contract order', () => {
    expect(findContractKeys({ summary: 'x', env: {}, commands: [], timeout: 5 })).toEqual(['commands', 'env', 'timeout']);
    expect(findContractKeys({ summary: 'x' })).toEqual([]);
    expect(findContractKeys(null)).toEqual([]);
    expect(findContractKeys(['commands'])).toEqual([]);
  });

  it('never overlaps a descriptive field', () => {
    expect(PLUGIN_CONTRACT_FIELDS.filter((k) => (PLUGIN_CATALOG_FIELDS as readonly string[]).includes(k))).toEqual([]);
  });

  it('explains that a contract change needs a new version', () => {
    expect(contractKeysMessage(['env'])).toMatch(/new version: env$/);
  });
});

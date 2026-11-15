// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: { passwordMinLength: 8 },
}));

const { ORG_SLUG_MAX, ORG_NAMESPACE_PREFIX, K8S_NAMESPACE_MAX } = await import('../src/constants/org-slug.js');
const {
  orgSlugBase, nextOrgSlug, orgSlugCollisionPattern, orgNamespaceName, isValidK8sNamespaceName,
} = await import('../src/helpers/org-slug.js');
const { updateOrganizationSchema } = await import('../src/utils/validation.js');

const RANDOM_BASE = /^org-[0-9a-f]{6}$/;
const passesEditSchema = (slug: string) => {
  const parsed = updateOrganizationSchema.safeParse({ slug });
  return parsed.success && parsed.data.slug === slug;
};

describe('org slug rule', () => {
  it('caps the slug so pb-org-<slug> fits a DNS-1123 label', () => {
    expect(ORG_SLUG_MAX).toBe(56);
    expect(ORG_NAMESPACE_PREFIX.length + ORG_SLUG_MAX).toBe(K8S_NAMESPACE_MAX);
  });

  it('edit schema refuses a 57-char slug and accepts a 56-char one', () => {
    expect(passesEditSchema('a'.repeat(56))).toBe(true);
    expect(updateOrganizationSchema.safeParse({ slug: 'a'.repeat(57) }).success).toBe(false);
  });
});

describe('orgSlugBase', () => {
  it('slugifies a Latin name', () => {
    expect(orgSlugBase('Acme Corp')).toBe('acme-corp');
  });

  it.each(['日本語チーム', '🚀🔥', '!!!', 'x'])('falls back to org-<hex> for %s', (name) => {
    expect(orgSlugBase(name)).toMatch(RANDOM_BASE);
  });

  it('two non-Latin names do not share a base slug', () => {
    expect(orgSlugBase('日本語チーム')).not.toBe(orgSlugBase('日本語チーム'));
  });

  it('truncates a long name, trims trailing hyphens, and leaves room for a suffix', () => {
    const base = orgSlugBase(`${'a'.repeat(48)} bbbbbbbbbbbbbbbbbbbbbbbb`);
    expect(base).toBe('a'.repeat(48));
    expect(nextOrgSlug(base, [base, `${base}-999998`]).length).toBeLessThanOrEqual(ORG_SLUG_MAX);
  });

  it('collapses doubled hyphens so the result matches the edit schema', () => {
    expect(orgSlugBase('a -- b')).toBe('a-b');
  });

  it.each(['Acme Corp', '日本語チーム', 'Ünïcödé Ørg', 'x'.repeat(200), 'a - - b', '  --lead and trail--  '])(
    'generated slug for %s passes the edit schema unchanged (with and without a suffix)',
    (name) => {
      const base = orgSlugBase(name);
      expect(passesEditSchema(base)).toBe(true);
      expect(passesEditSchema(nextOrgSlug(base, [base]))).toBe(true);
      expect(isValidK8sNamespaceName(orgNamespaceName(nextOrgSlug(base, [base])))).toBe(true);
    },
  );
});

describe('nextOrgSlug', () => {
  it('uses the base when free', () => {
    expect(nextOrgSlug('acme', [])).toBe('acme');
  });

  it('appends max suffix + 1 on collision', () => {
    expect(nextOrgSlug('acme', ['acme'])).toBe('acme-1');
    expect(nextOrgSlug('acme', ['acme', 'acme-4', 'acme-2'])).toBe('acme-5');
  });

  it('collision pattern matches only base and base-<n>', () => {
    const re = orgSlugCollisionPattern('acme');
    expect(re.test('acme')).toBe(true);
    expect(re.test('acme-12')).toBe(true);
    expect(re.test('acme-corp')).toBe(false);
    expect(re.test('xacme')).toBe(false);
  });
});

describe('isValidK8sNamespaceName', () => {
  it('rejects the namespace of a 57-char slug (64 chars total)', () => {
    const slug = 'a'.repeat(57);
    expect(orgNamespaceName(slug)).toHaveLength(64);
    expect(isValidK8sNamespaceName(orgNamespaceName(slug))).toBe(false);
  });

  it('accepts the namespace of a 56-char slug', () => {
    expect(isValidK8sNamespaceName(orgNamespaceName('a'.repeat(56)))).toBe(true);
  });

  it.each(['pb-org-', 'pb-org-Acme', 'pb-org-a_b', ''])('rejects %p', (name) => {
    expect(isValidK8sNamespaceName(name)).toBe(false);
  });
});

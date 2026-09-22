// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parts of the public plugin directory queries:
 * the icon trust rules, card mapping, highlighting, cursors and query
 * normalization. The SQL itself reads only the public_* views; it is exercised
 * against a real Postgres + pgbouncer in the deploy verification, not here.
 */

import { describe, it, expect } from '@jest/globals';
import {
  decodeOffsetCursor, encodeOffsetCursor, highlightText, normalizeQuery, resolveListingIcon, toListingCard,
  DIRECTORY_MAX_QUERY_LENGTH, type PublicListingRow,
} from '../src/api/public-directory.js';

function row(overrides: Partial<PublicListingRow> = {}): PublicListingRow {
  return {
    id: 'l1',
    publisher_handle: 'pipeline-builder',
    publisher_display_name: 'Pipeline Builder',
    publisher_tier: 'official',
    name: 'trivy',
    category: 'security',
    summary: 'Scan for vulnerabilities',
    description: null,
    readme_html: null,
    license: 'Apache-2.0',
    homepage_url: null,
    source_url: null,
    icon: { key: 'trivy' },
    uploaded_icon: null,
    keywords: ['cve'],
    latest_version: '1.1.0',
    updated_at: '2026-09-21T00:00:00.000Z',
    rating_bayes: '4.4567',
    rating_count: '12',
    rating_dist: null,
    install_count: '40',
    active_org_count: null,
    state: 'listed',
    ...overrides,
  };
}

describe('resolveListingIcon — who may show which icon', () => {
  it('gives Official and Verified publishers their curated vendor mark (with badge)', () => {
    expect(resolveListingIcon(row({ icon: { key: 'snyk', badge: 'python' } })))
      .toMatchObject({ iconKind: 'vendor', iconKey: 'snyk', iconBadge: 'python', iconUrl: null });
    expect(resolveListingIcon(row({ publisher_tier: 'verified' }))).toMatchObject({ iconKind: 'vendor', iconKey: 'trivy' });
  });

  it.each(['community', 'unverified'] as const)('never gives a %s listing a curated vendor mark', (tier) => {
    expect(resolveListingIcon(row({ publisher_tier: tier, icon: { key: 'trivy' } })))
      .toEqual({ iconKind: 'monogram', iconKey: null, iconBadge: null, iconHex: null, iconUrl: null });
  });

  it('prefers an uploaded icon, served from the public API', () => {
    expect(resolveListingIcon(row({ publisher_tier: 'community', uploaded_icon: { key256: 'ab/cd 256.webp', key64: 'x' } })))
      .toMatchObject({ iconKind: 'uploaded', iconUrl: '/api/public/plugins/icons/ab%2Fcd%20256.webp', iconKey: null });
  });

  it('falls back to a monogram when there is no icon', () => {
    expect(resolveListingIcon(row({ icon: null })).iconKind).toBe('monogram');
  });
});

describe('toListingCard', () => {
  it('maps a view row to the public card shape, numbers parsed', () => {
    expect(toListingCard(row())).toEqual({
      publisher: { handle: 'pipeline-builder', displayName: 'Pipeline Builder', tier: 'official' },
      name: 'trivy',
      summary: 'Scan for vulnerabilities',
      category: 'security',
      keywords: ['cve'],
      latestVersion: '1.1.0',
      license: 'Apache-2.0',
      iconKind: 'vendor',
      iconKey: 'trivy',
      iconBadge: null,
      iconHex: null,
      iconUrl: null,
      rating: { score: 4.46, count: 12 },
      installCount: 40,
      healthScore: null,
      updatedAt: '2026-09-21T00:00:00.000Z',
      state: 'listed',
    });
  });

  it('carries the health score, rounded, null when not computed', () => {
    expect(toListingCard(row({ health_score: '86.4' })).healthScore).toBe(86);
    expect(toListingCard(row({ health_score: null })).healthScore).toBeNull();
  });

  it('shows no rating until someone has rated', () => {
    expect(toListingCard(row({ rating_count: 0, rating_bayes: null })).rating).toBeNull();
  });

  it('keeps an unmaintained listing public, with its state', () => {
    expect(toListingCard(row({ state: 'unmaintained' })).state).toBe('unmaintained');
  });

  it('never carries tenant identifiers (the view has none, the card adds none)', () => {
    const keys = JSON.stringify(Object.keys(toListingCard(row())));
    for (const forbidden of ['orgId', 'org_id', 'ownerOrgId', 'createdBy', 'id']) {
      expect(keys).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('highlightText', () => {
  it('wraps each matched term, case-insensitively', () => {
    expect(highlightText('Scan for Vulnerabilities fast', 'vulnerabilities scan'))
      .toBe('<mark>Scan</mark> for <mark>Vulnerabilities</mark> fast');
  });

  it('returns undefined when nothing matched (the card renders plain text)', () => {
    expect(highlightText('terraform-plan', 'zzz')).toBeUndefined();
    expect(highlightText('', 'x')).toBeUndefined();
  });

  it('treats regex metacharacters in the query as literals', () => {
    expect(highlightText('a (b) c', '(b)')).toBeUndefined(); // "(b)" has no ≥2-char term after splitting
    expect(() => highlightText('x.y', 'x.y*+?')).not.toThrow();
  });

  it('does not escape the source text — the frontend renders everything but <mark> as text', () => {
    expect(highlightText('lint <script>x</script>', 'lint')).toBe('<mark>lint</mark> <script>x</script>');
  });
});

describe('cursors', () => {
  it('round-trips an offset', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(48))).toBe(48);
  });

  it.each([undefined, '', 'not-base64!', Buffer.from('{"o":-1}').toString('base64url'),
    Buffer.from('{"o":1.5}').toString('base64url'), Buffer.from('{"o":99999}').toString('base64url')])(
    'treats a missing/forged cursor %p as the first page', (cursor) => {
      expect(decodeOffsetCursor(cursor as string | undefined)).toBe(0);
    });
});

describe('normalizeQuery', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeQuery('  terraform   plan ')).toBe('terraform plan');
  });

  it('caps the length instead of failing', () => {
    expect(normalizeQuery('x'.repeat(500))).toHaveLength(DIRECTORY_MAX_QUERY_LENGTH);
  });

  it('handles an absent query', () => {
    expect(normalizeQuery(undefined)).toBe('');
  });
});

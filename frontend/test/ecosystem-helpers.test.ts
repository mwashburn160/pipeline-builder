// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Pure helpers behind the ecosystem screens: the card-preview builder, quota copy and the review line diff. */

import { describe, it, expect } from '@jest/globals';
import {
  applyCatalogEdits, buildPreviewCard, formatListingsQuota, isListingsQuotaFull, isOpenRequest,
} from '../src/lib/ecosystem';
import { diffLines } from '../src/lib/line-diff';

describe('buildPreviewCard', () => {
  const publisher = { handle: 'acme', displayName: 'Acme', tier: 'verified' as const };

  it('uses a curated icon key as a vendor icon, keeping its badge', () => {
    const card = buildPreviewCard({ name: 'mvn', version: '1.0.0', publisher, values: { icon: { key: 'apachemaven', badge: 'python' }, summary: 'Build' } });
    expect(card).toMatchObject({ iconKind: 'vendor', iconKey: 'apachemaven', iconBadge: 'python', summary: 'Build', latestVersion: '1.0.0' });
    expect(card.publisher).toEqual(publisher);
  });

  it('falls back to the monogram for an unknown key, and to the description for the summary', () => {
    const card = buildPreviewCard({ name: 'x', version: '0.1.0', publisher: null, values: { icon: 'no-such-icon', description: 'Long text', keywords: ['a', 3] } });
    expect(card).toMatchObject({ iconKind: 'monogram', iconKey: null, summary: 'Long text', keywords: ['a'], category: 'other' });
    expect(card.publisher.tier).toBe('community');
  });
});

describe('catalog edits and quota', () => {
  it('lays edits over detected values; null clears', () => {
    expect(applyCatalogEdits([{ field: 'summary', value: 'a' }, { field: 'license', value: 'MIT' }], { summary: 'b', license: null }))
      .toEqual({ summary: 'b', license: null });
  });

  it('formats the listings quota', () => {
    expect(formatListingsQuota({ used: 2, limit: 3 })).toBe('2 of 3');
    expect(formatListingsQuota({ used: 7, limit: -1 })).toBe('7 (unlimited)');
    expect(isListingsQuotaFull({ used: 3, limit: 3 })).toBe(true);
    expect(isListingsQuotaFull({ used: 99, limit: -1 })).toBe(false);
  });

  it('knows which statuses are open', () => {
    expect(isOpenRequest('pending')).toBe(true);
    expect(isOpenRequest('pending_second_approval')).toBe(true);
    expect(isOpenRequest('approved')).toBe(false);
  });
});

describe('diffLines', () => {
  it('keeps common lines and marks changes', () => {
    expect(diffLines('FROM a\nRUN x\nCMD y', 'FROM b\nRUN x\nCMD y\nUSER z')).toEqual([
      { op: 'del', text: 'FROM a' },
      { op: 'add', text: 'FROM b' },
      { op: 'same', text: 'RUN x' },
      { op: 'same', text: 'CMD y' },
      { op: 'add', text: 'USER z' },
    ]);
  });

  it('treats a missing side as empty', () => {
    expect(diffLines(null, 'a')).toEqual([{ op: 'add', text: 'a' }]);
    expect(diffLines('a', null)).toEqual([{ op: 'del', text: 'a' }]);
  });

  it('degrades to remove-all/add-all past the size cap', () => {
    const big = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n');
    const out = diffLines(big, 'x');
    expect(out).toHaveLength(2002);
    expect(out[out.length - 1]).toEqual({ op: 'add', text: 'x' });
  });
});

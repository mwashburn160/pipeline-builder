// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import {
  AUDIT_QUICK_FILTERS,
  auditQuickFilterActions,
  isAuditQuickFilterKey,
} from '../src/lib/audit-quick-filters';

describe('audit quick filters — definitions', () => {
  it('keeps every group’s patterns disjoint (so per-pattern totals sum exactly)', () => {
    for (const { patterns } of Object.values(AUDIT_QUICK_FILTERS)) {
      for (const a of patterns) {
        for (const b of patterns) {
          if (a === b) continue;
          // A server substring query for `a` must never hit an action matched by `b`.
          const sample = b.endsWith('.') ? `${b}x` : b;
          expect(sample.toLowerCase().includes(a.toLowerCase())).toBe(false);
        }
      }
    }
  });

  it('recognizes only the known group keys', () => {
    expect(isAuditQuickFilterKey('ecosystem')).toBe(true);
    expect(isAuditQuickFilterKey('moderation')).toBe(true);
    expect(isAuditQuickFilterKey('')).toBe(false);
    expect(isAuditQuickFilterKey(undefined)).toBe(false);
  });
});

describe('auditQuickFilterActions', () => {
  it('sends a group as one comma-separated actions list', () => {
    expect(auditQuickFilterActions('ecosystem')).toBe(AUDIT_QUICK_FILTERS.ecosystem.patterns.join(','));
    // Server-side validation accepts only action names / prefixes.
    for (const key of ['ecosystem', 'moderation'] as const) {
      for (const p of AUDIT_QUICK_FILTERS[key].patterns) expect(p).toMatch(/^[a-z0-9][a-z0-9._-]*$/i);
      expect(AUDIT_QUICK_FILTERS[key].patterns.length).toBeLessThanOrEqual(25);
    }
  });
});

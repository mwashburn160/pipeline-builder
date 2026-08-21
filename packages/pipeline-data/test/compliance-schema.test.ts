// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getTableConfig } from 'drizzle-orm/pg-core';
import { complianceRule } from '../src/database/schema/compliance.js';

describe('compliance_rules schema', () => {
  const { indexes } = getTableConfig(complianceRule);

  it('declares a partial GIN index on tags for the published set-tag lookup', () => {
    const gin = indexes.find((i) => i.config.name === 'compliance_rule_published_tags_gin_idx');
    expect(gin).toBeDefined();

    // GIN access method — the index backing `tags @> '[...]'::jsonb` containment.
    expect(gin!.config.method).toBe('gin');

    // Partial: scoped to published rows only (not every org's private tags).
    expect(gin!.config.where).toBeDefined();
    const predicate = gin!.config.where!.queryChunks
      .map((c: unknown) => (typeof c === 'object' && c !== null && 'value' in c
        ? (c as { value: unknown[] }).value.join('')
        : String(c)))
      .join('');
    expect(predicate).toContain("scope = 'published'");

    // Indexes the tags column.
    const indexed = gin!.config.columns
      .map((c: unknown) => (c as { name?: string }).name)
      .filter(Boolean);
    expect(indexed).toContain('tags');
  });
});

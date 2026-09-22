// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/catalog-metadata — the storage mapping of a resolved
 * catalog (plugin-ecosystem §3.1a). Detection and accept-or-edit are api-core's
 * (`plugin-catalog-detect`), tested there.
 */

import { describe, it, expect } from '@jest/globals';
import { detectCatalogMetadata, resolveCatalogMetadata } from '@pipeline-builder/api-core';
import type { PluginSpec } from '@pipeline-builder/pipeline-core';
import { catalogColumns } from '../src/helpers/catalog-metadata.js';

const spec = (s: Partial<PluginSpec> = {}): PluginSpec => ({ name: 'trivy', version: '1.0.0', commands: ['trivy'], ...s } as PluginSpec);

describe('catalogColumns', () => {
  it('maps values onto columns, rendering the README once to sanitized HTML', () => {
    const cols = catalogColumns(resolveCatalogMetadata(
      detectCatalogMetadata({ spec: spec({ keywords: ['a'] }), readmeMd: '# T\n\n<script>x</script>Hi', dockerfileContent: null }),
      { icon: { key: 'trivy', badge: 'python' } },
    ));
    expect(cols.category).toBe('unknown');
    expect(cols.keywords).toEqual(['a']);
    expect(cols.readmeMd).toContain('<script>');
    expect(cols.readmeHtml).not.toContain('<script>');
    expect(cols.icon).toEqual({ key: 'trivy', badge: 'python' });
    expect(cols.metadataSources).toMatchObject({ icon: 'user', readme: 'readme', keywords: 'spec' });
  });

  it('stores empty values as null, never empty strings', () => {
    const cols = catalogColumns({ values: { description: '', readme: null } as never, sources: {} });
    expect(cols.description).toBeNull();
    expect(cols.readmeHtml).toBeNull();
    expect(cols.keywords).toEqual([]);
    expect(cols.icon).toBeNull();
  });
});

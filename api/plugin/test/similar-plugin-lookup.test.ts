// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/similar-plugin-lookup — the tenant-scoped catalog read
 * behind the AI generator's similar-plugins hint. The hint is fail-soft: a DB
 * failure must yield `[]`, never fail generation.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockWithTenantTx = jest.fn<(fn: (tx: any) => Promise<unknown>) => Promise<unknown>>();
const mockBuildPluginConditions = jest.fn<(...args: any[]) => any[]>(() => []);
const mockWithViewerContext = jest.fn((f: unknown) => f);
const mockResolutionOrderBy = jest.fn<(...args: any[]) => any[]>(() => []);
const mockWarn = jest.fn();

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  withTenantTx: mockWithTenantTx,
  buildPluginConditions: mockBuildPluginConditions,
  withViewerContext: mockWithViewerContext,
  pluginResolutionOrderBy: mockResolutionOrderBy,
  schema: {
    plugin: Object.fromEntries([
      'id', 'name', 'version', 'category', 'summary', 'description', 'keywords',
      'deletedAt', 'deprecatedAt', 'yankedAt', 'lifecycle',
    ].map((c) => [c, c])),
  },
}));

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...c: unknown[]) => ({ and: c }),
  asc: (c: unknown) => ({ asc: c }),
  isNull: (c: unknown) => ({ isNull: c }),
  notInArray: (c: unknown, v: unknown) => ({ notInArray: [c, v] }),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ warn: mockWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { findSimilarPlugins, setSimilarPluginHealthLookupForTests } = await import('../src/services/similar-plugin-lookup.js');
const mockHealth = jest.fn<(ids: string[]) => Promise<Map<string, number>>>(async () => new Map());
setSimilarPluginHealthLookupForTests(mockHealth);

/** A fake drizzle tx recording the chained query and resolving to `rows`. */
function fakeTx(rows: unknown[]) {
  const calls: Record<string, unknown[]> = {};
  const chain: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) {
    chain[m] = (...args: unknown[]) => { calls[m] = args; return chain; };
  }
  chain.limit = (n: number) => { calls.limit = [n]; return Promise.resolve(rows); };
  return { chain, calls };
}

describe('findSimilarPlugins', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('queries the visible catalog under the tenant tx and ranks the rows', async () => {
    const { chain, calls } = fakeTx([
      { id: 'a', name: 'eslint', version: '2.0.0', category: 'quality', summary: 'Lints JS', description: null, keywords: ['lint'] },
      { id: 'b', name: 'maven', version: '1.0.0', category: 'build', summary: null, description: null, keywords: [] },
    ]);
    mockWithTenantTx.mockImplementation((fn) => fn(chain));

    const out = await findSimilarPlugins('eslint lint', 'org-1', 'parent-1');

    expect(out).toEqual([{ id: 'a', name: 'eslint', version: '2.0.0', category: 'quality', summary: 'Lints JS', keywords: ['lint'] }]);
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1);
    // Shared visibility ladder with the viewer stamped, own org + parent.
    expect(mockWithViewerContext).toHaveBeenCalledWith({});
    expect(mockBuildPluginConditions).toHaveBeenCalledWith({}, 'org-1', 'parent-1');
    expect(mockResolutionOrderBy).toHaveBeenCalledWith('org-1', 'parent-1');
    // Deleted / deprecated / yanked never offered; the read is bounded.
    const where = JSON.stringify(calls.where);
    expect(where).toContain('"isNull":"deletedAt"');
    expect(where).toContain('"isNull":"deprecatedAt"');
    expect(where).toContain('"isNull":"yankedAt"');
    expect(where).toContain('["deprecated","yanked"]');
    expect(calls.limit[0]).toBeGreaterThan(0);
    expect(Object.keys(calls.select[0] as object).sort()).toEqual(['category', 'description', 'id', 'keywords', 'name', 'summary', 'version']);
  });

  it('breaks ties with the listed version\'s health, and ranks without it when that lookup fails', async () => {
    const rows = [
      { id: 'a', name: 'node-build-a', version: '1.0.0', category: null, summary: null, description: null, keywords: [] },
      { id: 'b', name: 'node-build-b', version: '1.0.0', category: null, summary: null, description: null, keywords: [] },
    ];
    mockWithTenantTx.mockImplementation((fn) => fn(fakeTx(rows).chain));
    mockHealth.mockResolvedValueOnce(new Map([['b', 88]]));
    expect((await findSimilarPlugins('node build', 'org-1')).map((p) => p.name)).toEqual(['node-build-b', 'node-build-a']);
    expect(mockHealth).toHaveBeenCalledWith(['a', 'b']);
    mockHealth.mockRejectedValueOnce(new Error('stats down'));
    expect((await findSimilarPlugins('node build', 'org-1')).map((p) => p.name)).toEqual(['node-build-a', 'node-build-b']);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('health lookup failed'), { orgId: 'org-1', error: 'stats down' });
  });

  it('is fail-soft: a lookup failure logs a warning and returns []', async () => {
    mockWithTenantTx.mockRejectedValue(new Error('db down'));

    await expect(findSimilarPlugins('eslint', 'org-1')).resolves.toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Similar-plugin lookup failed'), { orgId: 'org-1', error: 'db down' });
  });
});

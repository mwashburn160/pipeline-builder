// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/similar-plugins — the pure ranking behind the AI
 * generator's "similar plugins already exist" hint (plugin-ecosystem W6).
 */

import { describe, it, expect } from '@jest/globals';

import {
  MAX_SIMILAR_PLUGINS, rankSimilarPlugins, scoreCandidate, tokenize, type SimilarPluginCandidate,
} from '../src/helpers/similar-plugins.js';

function candidate(overrides: Partial<SimilarPluginCandidate> & { name: string }): SimilarPluginCandidate {
  return {
    id: `id-${overrides.name}-${overrides.version ?? '1.0.0'}`,
    version: '1.0.0',
    category: null,
    summary: null,
    description: null,
    keywords: [],
    ...overrides,
  };
}

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, and drops stopwords and 1-char tokens', () => {
    expect([...tokenize('Create a Node.js build plugin for the X project')]).toEqual(['node', 'js', 'build', 'project']);
  });

  it('returns an empty set for empty/null input', () => {
    expect(tokenize(null).size).toBe(0);
    expect(tokenize(undefined).size).toBe(0);
    expect(tokenize('   ').size).toBe(0);
  });
});

describe('scoreCandidate', () => {
  const prompt = tokenize('python lint with ruff for security');

  it('weights name > keywords > category > description', () => {
    expect(scoreCandidate(prompt, candidate({ name: 'python-x' }))).toBe(5);
    expect(scoreCandidate(prompt, candidate({ name: 'zz', keywords: ['ruff'] }))).toBe(3);
    expect(scoreCandidate(prompt, candidate({ name: 'zz', category: 'security' }))).toBe(2);
    expect(scoreCandidate(prompt, candidate({ name: 'zz', description: 'a lint tool' }))).toBe(1);
  });

  it('ignores a non-array keywords column', () => {
    expect(scoreCandidate(prompt, candidate({ name: 'zz', keywords: 'ruff' }))).toBe(0);
    expect(scoreCandidate(prompt, candidate({ name: 'zz', keywords: [1, 'ruff'] }))).toBe(3);
  });
});

describe('rankSimilarPlugins', () => {
  it('ranks by score, name matches highest', () => {
    const ranked = rankSimilarPlugins('eslint lint for typescript', [
      candidate({ name: 'prettier-format', description: 'formats typescript and lint' }),
      candidate({ name: 'eslint', keywords: ['lint'], category: 'quality' }),
      candidate({ name: 'tsc-check', keywords: ['typescript'] }),
    ]);
    expect(ranked.map((p) => p.name)).toEqual(['eslint', 'tsc-check', 'prettier-format']);
  });

  it('drops candidates below the minimum score', () => {
    const ranked = rankSimilarPlugins('golang build', [
      candidate({ name: 'java-maven', description: 'maven build for java' }), // single description hit
      candidate({ name: 'go-build', keywords: ['golang'] }),
    ]);
    expect(ranked.map((p) => p.name)).toEqual(['go-build']);
  });

  it('keeps only the first row per name (the preferred version)', () => {
    const ranked = rankSimilarPlugins('trivy scan', [
      candidate({ name: 'trivy', version: '3.0.0' }),
      candidate({ name: 'trivy', version: '2.0.0', keywords: ['scan'] }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ name: 'trivy', version: '3.0.0', id: 'id-trivy-3.0.0' });
  });

  it('caps the result and keeps input order on ties', () => {
    const many = Array.from({ length: 8 }, (_, i) => candidate({ name: `node-build-${i}` }));
    const ranked = rankSimilarPlugins('node build', many);
    expect(ranked).toHaveLength(MAX_SIMILAR_PLUGINS);
    expect(ranked.map((p) => p.name)).toEqual(['node-build-0', 'node-build-1', 'node-build-2', 'node-build-3', 'node-build-4']);
    expect(rankSimilarPlugins('node build', many, 2)).toHaveLength(2);
    expect(rankSimilarPlugins('node build', many, 0)).toEqual([]);
  });

  it('breaks score ties by health score (W7), unknown health last', () => {
    const ranked = rankSimilarPlugins('node build', [
      candidate({ name: 'node-build-a', healthScore: null }),
      candidate({ name: 'node-build-b', healthScore: 60 }),
      candidate({ name: 'node-build-c', healthScore: 90 }),
    ]);
    expect(ranked.map((p) => p.name)).toEqual(['node-build-c', 'node-build-b', 'node-build-a']);
    // Health never outranks a better match.
    expect(rankSimilarPlugins('eslint lint', [
      candidate({ name: 'lint-other', healthScore: 100 }),
      candidate({ name: 'eslint', keywords: ['lint'], healthScore: 10 }),
    ])[0]!.name).toBe('eslint');
  });

  it('returns nothing for a prompt with no meaningful tokens', () => {
    expect(rankSimilarPlugins('create a plugin', [candidate({ name: 'plugin-create' })])).toEqual([]);
  });

  it('prefers the summary, else a flattened, truncated description', () => {
    const [withSummary, withDesc, bare] = rankSimilarPlugins('docker image', [
      candidate({ name: 'docker-a', summary: 'Builds images', description: 'long' }),
      candidate({ name: 'docker-b', description: `line one\n\tline two ${'y'.repeat(300)}` }),
      candidate({ name: 'docker-c', summary: '   ' }),
    ]);
    expect(withSummary.summary).toBe('Builds images');
    expect(withDesc.summary).toMatch(/^line one line two y+…$/);
    expect(withDesc.summary!.length).toBe(160);
    expect(bare.summary).toBeNull();
  });

  it('returns only string keywords, capped at 10', () => {
    const kw = [...Array.from({ length: 12 }, (_, i) => `k${i}`), 7];
    const [p] = rankSimilarPlugins('helm deploy', [candidate({ name: 'helm-deploy', keywords: kw, category: 'deploy' })]);
    expect(p.keywords).toHaveLength(10);
    expect(p).toMatchObject({ category: 'deploy', version: '1.0.0' });
  });
});

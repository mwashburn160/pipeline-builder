// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { tokenize, chunkMarkdown, buildGroundingIndex, buildDocsIndexFromFiles } from '../src/grounding.js';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and 1-char tokens', () => {
    expect(tokenize('How do I configure Alertmanager?')).toEqual(['configure', 'alertmanager']);
  });

  it('splits identifiers on underscores/symbols and keeps the parts', () => {
    const t = tokenize('Set OPENAI_COMPATIBLE_BASE_URL to http://x');
    expect(t).toEqual(expect.arrayContaining(['set', 'openai', 'compatible', 'base', 'url', 'http']));
    expect(t).not.toContain('to'); // stopword
    expect(t).not.toContain('x'); // 1-char
  });
});

describe('chunkMarkdown', () => {
  it('splits into heading-scoped chunks and strips front-matter', () => {
    const md = [
      '---',
      'title: Deploy',
      '---',
      'Intro line before any heading.',
      '',
      '# Setup',
      'Run the installer.',
      '',
      '## Alertmanager',
      'Point your tooling at the in-cluster Alertmanager.',
    ].join('\n');

    const chunks = chunkMarkdown(md, { id: 'deployment.md', url: '/docs/deployment' });

    // intro + Setup + Alertmanager
    expect(chunks).toHaveLength(3);
    const alert = chunks.find((c) => c.title === 'Alertmanager');
    expect(alert).toBeDefined();
    expect(alert!.id).toBe('deployment.md#alertmanager');
    expect(alert!.url).toBe('/docs/deployment');
    expect(alert!.text).toContain('in-cluster Alertmanager');
  });

  it('skips empty sections', () => {
    const chunks = chunkMarkdown('# Empty\n\n# Real\nbody', { id: 'x.md' });
    expect(chunks.map((c) => c.title)).toEqual(['Real']);
  });

  it('does NOT treat # comment lines inside a fenced code block as headings', () => {
    const md = [
      '# Deploy',
      'Run these steps:',
      '```bash',
      '# Step 1: generate',
      'pb generate',
      '# Step 2: deploy',
      'pb deploy',
      '```',
      'Done.',
    ].join('\n');
    const chunks = chunkMarkdown(md, { id: 'deploy.md' });
    // One "Deploy" chunk — the fenced `# Step` lines must NOT split it.
    expect(chunks.map((c) => c.title)).toEqual(['Deploy']);
    expect(chunks[0].text).toContain('# Step 1: generate');
    expect(chunks[0].text).toContain('pb deploy');
  });
});

describe('buildGroundingIndex', () => {
  const docs = [
    { id: 'a', text: 'Alertmanager configuration for in-cluster incident routing and receivers.' },
    { id: 'b', text: 'Billing and Stripe subscription plans, add-ons, and marketplace metering.' },
    { id: 'c', text: 'Pipeline creation from a prompt using AI generation.' },
  ];

  it('ranks the most relevant chunk first', () => {
    const index = buildGroundingIndex(docs);
    const hits = index.search('how do I configure alertmanager receivers');
    expect(hits[0].doc.id).toBe('a');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('respects the top-k limit', () => {
    const index = buildGroundingIndex(docs);
    expect(index.search('billing pipeline alertmanager', 2)).toHaveLength(2);
  });

  it('returns no hits for a query with only stopwords / unknown terms', () => {
    const index = buildGroundingIndex(docs);
    expect(index.search('how do I')).toEqual([]);
    expect(index.search('kubernetes helm istio')).toEqual([]);
  });

  it('reports its size and handles an empty corpus', () => {
    expect(buildGroundingIndex([]).size).toBe(0);
    expect(buildGroundingIndex([]).search('anything')).toEqual([]);
    expect(buildGroundingIndex(docs).size).toBe(3);
  });
});

describe('buildDocsIndexFromFiles', () => {
  it('chunks multiple markdown files into one searchable index', () => {
    const index = buildDocsIndexFromFiles([
      { id: 'deployment.md', content: '# Alertmanager\nRoute incidents to the in-cluster Alertmanager.', url: '/docs/deployment' },
      { id: 'billing.md', content: '# Stripe\nConfigure subscription plans and add-ons.' },
    ]);
    expect(index.size).toBe(2);
    const hits = index.search('alertmanager incidents');
    expect(hits[0].doc.id).toBe('deployment.md#alertmanager');
    expect(hits[0].doc.url).toBe('/docs/deployment');
  });
});

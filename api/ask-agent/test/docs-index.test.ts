// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/docs-index.ts — the how-to grounding corpus: every `*.md` under
 * ASK_DOCS_DIR (recursively, nothing else) becomes a doc with a docs-site url;
 * the built index is cached once built, concurrent first callers share ONE
 * build, and an EMPTY corpus (missing dir) is never cached so a later call
 * retries instead of leaving every answer ungrounded for the process lifetime.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const DIR = mkdtempSync(join(tmpdir(), 'ask-docs-'));
process.env.ASK_DOCS_DIR = join(DIR, 'docs');

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
const built: Array<Array<{ id: string; url: string; content: string }>> = [];
const buildDocsIndexFromFiles = jest.fn<AnyFn>((files: Array<{ id: string; url: string; content: string }>) => {
  built.push(files);
  return { size: files.length, search: () => [] };
});
jest.unstable_mockModule('@pipeline-builder/ai-core', () => stubModule('@pipeline-builder/ai-core', { buildDocsIndexFromFiles }));

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

beforeEach(() => {
  jest.resetModules();
  built.length = 0;
  buildDocsIndexFromFiles.mockClear();
  rmSync(join(DIR, 'docs'), { recursive: true, force: true });
});

const load = async () => (await import('../src/services/docs-index.js')).getDocsIndex;

describe('getDocsIndex', () => {
  it('indexes every markdown file recursively, with a docs-site url, and ignores other files', async () => {
    mkdirSync(join(DIR, 'docs', 'runbooks'), { recursive: true });
    writeFileSync(join(DIR, 'docs', 'deployment.md'), '# Deploy');
    writeFileSync(join(DIR, 'docs', 'runbooks', 'secret-rotation.md'), '# Rotate');
    writeFileSync(join(DIR, 'docs', 'diagram.png'), 'not markdown');
    const getDocsIndex = await load();
    const index = await getDocsIndex();
    expect(index.size).toBe(2);
    expect(built[0]!.map((f) => [f.id, f.url]).sort()).toEqual([
      ['deployment.md', 'docs/deployment'],
      ['runbooks/secret-rotation.md', 'docs/runbooks/secret-rotation'],
    ]);
  });

  it('builds once: concurrent first callers share the build and later calls hit the cache', async () => {
    mkdirSync(join(DIR, 'docs'), { recursive: true });
    writeFileSync(join(DIR, 'docs', 'a.md'), '# A');
    const getDocsIndex = await load();
    const [a, b] = await Promise.all([getDocsIndex(), getDocsIndex()]);
    const c = await getDocsIndex();
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(buildDocsIndexFromFiles).toHaveBeenCalledTimes(1);
  });

  it('never caches an EMPTY corpus: a missing docs dir is retried on the next call', async () => {
    const getDocsIndex = await load();
    expect((await getDocsIndex()).size).toBe(0);
    mkdirSync(join(DIR, 'docs'), { recursive: true });
    writeFileSync(join(DIR, 'docs', 'late.md'), '# Late');
    expect((await getDocsIndex()).size).toBe(1);
    expect(buildDocsIndexFromFiles).toHaveBeenCalledTimes(2);
  });
});

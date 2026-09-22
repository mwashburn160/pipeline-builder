// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { buildDocsIndexFromFiles } from '@pipeline-builder/ai-core';
import type { GroundingIndex, DocFile } from '@pipeline-builder/ai-core';
import { createLogger } from '@pipeline-builder/api-core';

const logger = createLogger('ask-docs-index');

// Directory the how-to grounding corpus is loaded from. The service image bundles
// the repo's `docs/*.md` (the source-of-truth the in-app help mirrors); override the
// location with ASK_DOCS_DIR.
const DOCS_DIR = process.env.ASK_DOCS_DIR || join(process.cwd(), 'docs');

let cached: GroundingIndex | null = null;
let building: Promise<GroundingIndex> | null = null;

/** Recursively collect `*.md` file paths under `dir`. */
async function walkMarkdown(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // missing dir → empty corpus (logged by caller via size 0)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** Load every `docs/**.md` file into {@link DocFile}s (id + content + docs-site url). */
async function loadDocFiles(): Promise<DocFile[]> {
  const paths = await walkMarkdown(DOCS_DIR);
  const files: DocFile[] = [];
  for (const path of paths) {
    const rel = relative(DOCS_DIR, path).split(sep).join('/');
    const content = await readFile(path, 'utf8');
    files.push({ id: rel, content, url: `docs/${rel.replace(/\.md$/, '')}` });
  }
  return files;
}

/**
 * Lazily build and cache the BM25 grounding index over the docs corpus. Built once
 * per process on first use; the corpus is static within a deploy.
 *
 * @returns The queryable grounding index
 */
export async function getDocsIndex(): Promise<GroundingIndex> {
  if (cached) return cached;
  // Dedupe concurrent first-callers by caching the in-flight promise, not just the result.
  if (building) return building;
  building = (async () => {
    const files = await loadDocFiles();
    const index = buildDocsIndexFromFiles(files);
    if (index.size === 0) {
      // Do NOT cache an empty index — a missing/transient corpus would otherwise leave
      // every how-to answer ungrounded for the whole process lifetime. Warn loudly and
      // retry on the next call.
      logger.warn('Docs grounding index is EMPTY — how-to answers will be ungrounded', { files: files.length, dir: DOCS_DIR });
      return index;
    }
    cached = index;
    logger.info('Docs grounding index built', { files: files.length, chunks: index.size, dir: DOCS_DIR });
    return index;
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

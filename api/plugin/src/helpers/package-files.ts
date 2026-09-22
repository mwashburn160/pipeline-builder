// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read an extracted plugin package's files for the malware heuristics.
 * Bounded: at most {@link MAX_PACKAGE_FILES}
 * files, each capped at {@link HEURISTICS_MAX_FILE_BYTES} + 1 bytes (enough for
 * the scanner to see it is oversized and skip it without reading it all), and
 * only regular files — zip-extract never writes anything else, but the walk
 * doesn't follow links regardless.
 */

import * as fs from 'fs/promises';
import path from 'path';

import { HEURISTICS_MAX_FILE_BYTES, type HeuristicsInputFile } from '@pipeline-builder/api-core';

/** Files read per package (the extract entry cap bounds it too). */
export const MAX_PACKAGE_FILES = 2_000;

/** Every regular file under `root`, package-relative (POSIX separators), sorted. */
export async function readPackageFiles(root: string): Promise<HeuristicsInputFile[]> {
  const out: HeuristicsInputFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_PACKAGE_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const handle = await fs.open(full, 'r');
      try {
        const buf = Buffer.alloc(HEURISTICS_MAX_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        out.push({ path: rel, content: buf.subarray(0, bytesRead) });
      } finally {
        await handle.close();
      }
    }
  };
  await walk(root);
  return out;
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Safe ZIP extraction (zip-bomb + path-traversal defense), split out from
 * plugin-spec so it can be reused WITHOUT pulling in the spec-validation module
 * (and its pipeline-core template deps). The build worker uses {@link
 * extractZipToDir} to re-materialize a build context downloaded from object
 * storage; the upload path uses {@link readAndExtractZip} to extract + read spec
 * text in one pass.
 */

import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';

import { ValidationError } from '@pipeline-builder/api-core';
import yauzl from 'yauzl';

/**
 * Decompression limits (zip-bomb defense). Multer bounds only the *compressed*
 * upload; a few-KB ZIP can still expand to GB / millions of inodes. We cap
 * cumulative extracted bytes and entry count.
 *
 *   PLUGIN_MAX_UPLOAD_MB      compressed upload ceiling (mirrors CoreConstants; default 4096)
 *   PLUGIN_MAX_EXTRACT_RATIO  max expansion factor over the upload ceiling (default 50×)
 *   PLUGIN_MAX_EXTRACT_BYTES  absolute extracted-byte ceiling (overrides the ratio calc when set)
 *   PLUGIN_MAX_EXTRACT_ENTRIES max number of ZIP entries (default 10000)
 *
 * Read from env at call time (not module load) so operators — and tests — can
 * tune the ceiling without reloading the module.
 */
function extractionLimits(): { maxBytes: number; maxEntries: number } {
  const maxUploadMb = parseInt(process.env.PLUGIN_MAX_UPLOAD_MB || '4096', 10);
  const maxRatio = parseInt(process.env.PLUGIN_MAX_EXTRACT_RATIO || '50', 10);
  const maxBytes = parseInt(
    process.env.PLUGIN_MAX_EXTRACT_BYTES || String(maxUploadMb * 1024 * 1024 * maxRatio),
    10,
  );
  const maxEntries = parseInt(process.env.PLUGIN_MAX_EXTRACT_ENTRIES || '10000', 10);
  return { maxBytes, maxEntries };
}

/** Read specific text entries and extract all files in a single pass. */
export async function readAndExtractZip(
  zipPath: string,
  textEntries: string[],
  extractDir: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const wanted = new Set(textEntries);
  const { maxBytes, maxEntries } = extractionLimits();
  let totalBytes = 0;
  let entryCount = 0;

  return new Promise((resolve, reject) => {
    // autoClose:false — we own the fd lifecycle explicitly. yauzl's default
    // autoClose only fires on the natural `end` (or a yauzl-emitted error); it
    // does NOT close on our own validation rejects (entry-count cap, path
    // traversal, byte cap), which is exactly how the fd used to leak. Owning it
    // here guarantees a single close on EVERY terminal path.
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) return reject(err);

      // Close the underlying fd on EVERY terminal path — success AND every
      // reject (entry-count cap, path traversal, byte cap, stream/mkdir
      // errors). Previously `close()` ran only on the success `end` path, so a
      // rejected extraction (zip bomb / traversal spam) leaked an fd per
      // upload and could exhaust the process's descriptor table. `settled`
      // guards against a double-close if a later event fires after the promise
      // has already resolved/rejected.
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* fd already closed */ }
        fn();
      };
      const rejectOnce = (e: unknown): void => finish(() => reject(e));
      const resolveOnce = (v: Map<string, string>): void => finish(() => resolve(v));

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        // -- Entry-count cap ---------------------------------------------------
        entryCount += 1;
        if (entryCount > maxEntries) {
          return rejectOnce(new ValidationError(
            `ZIP exceeds the maximum entry count (${maxEntries}) — refusing to extract (possible zip bomb)`,
          ));
        }

        const targetPath = path.join(extractDir, entry.fileName);

        // Prevent path traversal
        if (!targetPath.startsWith(extractDir + path.sep) && targetPath !== extractDir) {
          return rejectOnce(new ValidationError(`ZIP entry escapes target directory: ${entry.fileName}`));
        }

        if (entry.fileName.endsWith('/')) {
          fs.mkdir(targetPath, { recursive: true }).then(() => zipfile.readEntry()).catch(rejectOnce);
          return;
        }

        // -- Byte cap (fast-path on the declared uncompressed size) ------------
        // yauzl surfaces the header's uncompressedSize; reject before streaming
        // when the declared expansion alone would blow the ceiling. The actual
        // per-chunk accounting below defends against a lying header.
        if (typeof entry.uncompressedSize === 'number' && totalBytes + entry.uncompressedSize > maxBytes) {
          return rejectOnce(new ValidationError(
            `ZIP exceeds the maximum extracted size (${maxBytes} bytes) — refusing to extract (possible zip bomb)`,
          ));
        }

        // Accumulate written bytes; abort past the ceiling even if the header lied.
        const countChunk = (chunk: Buffer): boolean => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            rejectOnce(new ValidationError(
              `ZIP exceeds the maximum extracted size (${maxBytes} bytes) — refusing to extract (possible zip bomb)`,
            ));
            return false;
          }
          return true;
        };

        // Stream file to disk
        fs.mkdir(path.dirname(targetPath), { recursive: true })
          .then(() => {
            zipfile.openReadStream(entry, (streamErr, stream) => {
              if (streamErr) return rejectOnce(streamErr);

              const writeStream = createWriteStream(targetPath);
              // A write failure (ENOSPC/EROFS on the upload volume) emits
              // 'error' on the write stream; without a listener it becomes an
              // unhandled exception and crashes the process. Gate the "done"
              // side-effects on the write's 'finish' (fully flushed) rather
              // than the read stream's 'end'.
              writeStream.on('error', rejectOnce);

              if (wanted.has(entry.fileName)) {
                // Capture text content AND write to disk
                const chunks: Buffer[] = [];
                writeStream.on('finish', () => {
                  results.set(entry.fileName, Buffer.concat(chunks).toString('utf-8'));
                  zipfile.readEntry();
                });
                stream.on('data', (chunk: Buffer) => {
                  if (!countChunk(chunk)) { stream.destroy(); writeStream.destroy(); return; }
                  chunks.push(chunk); writeStream.write(chunk);
                });
                stream.on('end', () => { writeStream.end(); });
                stream.on('error', rejectOnce);
              } else {
                // Just write to disk (with the same byte accounting)
                writeStream.on('finish', () => zipfile.readEntry());
                stream.on('data', (chunk: Buffer) => {
                  if (!countChunk(chunk)) { stream.destroy(); writeStream.destroy(); return; }
                  writeStream.write(chunk);
                });
                stream.on('end', () => { writeStream.end(); });
                stream.on('error', rejectOnce);
              }
            });
          })
          .catch(rejectOnce);
      });

      zipfile.on('end', () => resolveOnce(results));
      zipfile.on('error', rejectOnce);
    });
  });
}

/**
 * Extract EVERY file from a plugin ZIP into a fresh directory, with the same
 * zip-bomb protections as {@link readAndExtractZip} but WITHOUT any spec
 * validation — the spec was already validated at upload time. Used by the build
 * worker to reconstruct a build context downloaded from object storage on a
 * replica that did NOT receive the original upload (see plugin-artifact-storage).
 */
export async function extractZipToDir(zipPath: string, extractDir: string): Promise<void> {
  await fs.mkdir(extractDir, { recursive: true });
  await readAndExtractZip(zipPath, [], extractDir);
}

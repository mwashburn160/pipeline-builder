// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Safe ZIP extraction (zip-bomb, path-traversal and link/device-entry defense), split out from
 * plugin-spec so it can be reused WITHOUT pulling in the spec-validation module
 * (and its pipeline-core template deps). The build worker uses {@link
 * extractZipToDir} to re-materialize a build context downloaded from object
 * storage; the upload path uses {@link readAndExtractZip} to extract + read spec
 * text in one pass.
 */

import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import path from 'path';

import { envInt, ValidationError } from '@pipeline-builder/api-core';
import yauzl from 'yauzl';

/**
 * Decompression limits (zip-bomb defense). Multer bounds only the *compressed*
 * upload; a few-KB ZIP can still expand to GB / millions of inodes. We cap
 * cumulative extracted bytes and entry count.
 *
 *   PLUGIN_MAX_UPLOAD_MB compressed upload ceiling (mirrors CoreConstants; default 4096)
 *   PLUGIN_MAX_EXTRACT_RATIO max expansion factor over the upload ceiling (default 50×)
 *   PLUGIN_MAX_EXTRACT_BYTES absolute extracted-byte ceiling (overrides the ratio calc when set)
 *   PLUGIN_MAX_EXTRACT_ENTRIES max number of ZIP entries (default 10000)
 *
 * Read from env at call time (not module load) so operators — and tests — can
 * tune the ceiling without reloading the module. Every value goes through the
 * validated `envInt` parse (min 1): a bare `parseInt` turned a typo'd value into
 * `NaN`, and since `x > NaN` is always false that silently DISABLED the cap.
 */
export interface ExtractionLimits { maxBytes: number; maxEntries: number }

export function extractionLimits(): ExtractionLimits {
  const maxUploadMb = envInt('PLUGIN_MAX_UPLOAD_MB', 4096, { min: 1 });
  const maxRatio = envInt('PLUGIN_MAX_EXTRACT_RATIO', 50, { min: 1 });
  const maxBytes = envInt('PLUGIN_MAX_EXTRACT_BYTES', maxUploadMb * 1024 * 1024 * maxRatio, { min: 1 });
  const maxEntries = envInt('PLUGIN_MAX_EXTRACT_ENTRIES', 10000, { min: 1 });
  return { maxBytes, maxEntries };
}

/** Unix file-type bits of st_mode (as zip external attributes carry them). */
/** One past the permission bits: st_mode % this = permissions, the rest = S_IFMT type. */
const S_IFMT_UNIT = 0o10000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function describeFileType(type: number): string {
  switch (type) {
    case 0o120000: return 'symbolic link';
    case 0o140000: return 'socket';
    case 0o060000: return 'block device';
    case 0o020000: return 'character device';
    case 0o010000: return 'FIFO';
    default: return `special file (mode ${type.toString(8)})`;
  }
}

/**
 * Read specific text entries and extract all files in a single pass. `limits`
 * overrides the service-wide {@link extractionLimits} for one call — the
 * anonymous submission path passes much tighter ones (its caller is unknown).
 */
export async function readAndExtractZip(
  zipPath: string,
  textEntries: string[],
  extractDir: string,
  limits: ExtractionLimits = extractionLimits(),
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const wanted = new Set(textEntries);
  const { maxBytes, maxEntries } = limits;
  let totalBytes = 0;
  let entryCount = 0;

  return new Promise((resolve, reject) => {
    // autoClose:false — we own the fd lifecycle explicitly. yauzl's default
    // autoClose only fires on the natural `end` (or a yauzl-emitted error); it
    // does NOT close on our own validation rejects (entry-count cap, path
    // traversal, byte cap). Owning it here guarantees a single close on EVERY
    // terminal path.
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) return reject(err);

      // Close the underlying fd on EVERY terminal path — success AND every
      // reject (entry-count cap, path traversal, byte cap, stream/mkdir
      // errors) — or each rejected extraction (zip bomb / traversal spam)
      // would leak a descriptor. `settled` guards against a double-close if a
      // later event fires after the promise has already resolved/rejected.
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

        // -- Entry type -------------------------------------------------
        // Only regular files and directories. The high 16 bits of the external
        // attributes carry the Unix st_mode for zips made on Unix; a symlink,
        // hard-link/device/FIFO/socket type is refused outright rather than
        // written out as a regular file whose meaning changed (a symlink's
        // target text) — no build context ever needs one.
        // Arithmetic rather than bit ops (no-bitwise): mode = high 16 bits, type = its top 4 bits.
        const unixMode = Math.floor(entry.externalFileAttributes / 0x10000) % 0x10000;
        const fileType = unixMode - (unixMode % S_IFMT_UNIT);
        if (fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR) {
          return rejectOnce(new ValidationError(
            `ZIP entry ${entry.fileName} is a ${describeFileType(fileType)} — only regular files and directories are allowed`,
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

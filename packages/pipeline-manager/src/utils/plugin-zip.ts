// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Package a local plugin directory as the zip the upload API takes (the
 * directory IS the zip root). A small, dependency-free ZIP writer: DEFLATE
 * entries, regular files only — symlinks and anything outside the directory
 * are refused, which the server would refuse anyway.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/** Never packaged: build outputs and VCS/editor state. */
const EXCLUDED = new Set(['.git', '.DS_Store', 'node_modules', 'plugin.zip']);

export interface ZipEntry {
  /** Forward-slash path relative to the zip root. */
  name: string;
  data: Buffer;
}

/**
 * The files a plugin zip carries, sorted. `image.tar` rides along only for a
 * `prebuilt` plugin (the server builds `build_image` plugins itself).
 */
export function collectPluginFiles(dir: string, opts: { includeImageTar: boolean }): ZipEntry[] {
  const root = path.resolve(dir);
  const entries: ZipEntry[] = [];
  const walk = (abs: string): void => {
    for (const name of fs.readdirSync(abs).sort()) {
      if (EXCLUDED.has(name)) continue;
      const full = path.join(abs, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (rel === 'image.tar' && !opts.includeImageTar) continue;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`Refusing to package a symlink: ${rel}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) entries.push({ name: rel, data: fs.readFileSync(full) });
    }
  };
  walk(root);
  return entries;
}

/** DOS date/time for the zip headers (fixed, so a package is reproducible). */
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01: (0 years << 9) | (month 1 << 5) | day 1

/** Write `entries` as a ZIP archive. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = zlib.crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix (3), spec 2.0 (20)
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0o100644 * 0x10000, 38); // external attrs: regular file, -rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

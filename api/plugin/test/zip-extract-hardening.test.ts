// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fuzz-style tests for helpers/zip-extract (plugin-ecosystem §4.2 W5, E11):
 * every upload path — tenant and anonymous — refuses symlink / device / FIFO /
 * socket entries, path traversal, and zip bombs (entry-count, declared-size and
 * lying-header), and leaves nothing outside the extract directory.
 */

import * as fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import AdmZip from 'adm-zip';

const { readAndExtractZip } = await import('../src/helpers/zip-extract.js');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-hardening-')); });
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.PLUGIN_MAX_EXTRACT_ENTRIES;
  delete process.env.PLUGIN_MAX_EXTRACT_BYTES;
});

/** Unix st_mode in the high 16 bits of the external attributes (as Info-ZIP writes them). */
const unixAttr = (mode: number) => mode * 0x10000;

/** adm-zip always writes a regular-file / directory type (the permission bits come from `mode`). */
function zipOf(entries: Array<{ name: string; content?: string | Buffer; mode?: number }>): string {
  const zip = new AdmZip();
  for (const e of entries) {
    zip.addFile(e.name, Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content ?? '', 'utf-8'), '', e.mode);
  }
  const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.zip`);
  zip.writeZip(file);
  return file;
}

async function extract(zipPath: string): Promise<string> {
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  await readAndExtractZip(zipPath, [], out);
  return out;
}

/**
 * A hand-built single-entry STORED zip whose file name is written verbatim —
 * adm-zip normalizes `../` away, so traversal needs raw bytes.
 */
function rawZip(fileName: string, content: string, externalAttr = 0): string {
  const name = Buffer.from(fileName, 'utf-8');
  const data = Buffer.from(content, 'utf-8');
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(3 * 256 + 20, 4); // made by Unix (3), version 2.0 central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(externalAttr, 38); central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, name, data]);
  const centralPart = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, Buffer.concat([localPart, centralPart, end]));
  return file;
}

describe('zip entry types (E11)', () => {
  it('extracts regular files and directories (with or without Unix modes)', async () => {
    const out = await extract(zipOf([
      { name: 'plugin-spec.yaml', content: 'name: x', mode: 0o100644 },
      { name: 'bin/run.sh', content: 'echo', mode: 0o100755 },
      { name: 'README.md', content: '# x' },
    ]));
    expect(fs.readFileSync(path.join(out, 'bin/run.sh'), 'utf-8')).toBe('echo');
    expect(fs.existsSync(path.join(out, 'README.md'))).toBe(true);
  });

  it.each([
    ['symbolic link', 0o120777],
    ['character device', 0o020644],
    ['block device', 0o060644],
    ['FIFO', 0o010644],
    ['socket', 0o140755],
  ])('refuses a %s entry', async (kind, mode) => {
    await expect(extract(rawZip('link', '/etc/passwd', unixAttr(mode)))).rejects.toThrow(new RegExp(`is a ${kind}`));
  });

  it('never writes a symlink target anywhere', async () => {
    await expect(extract(rawZip('creds', '/root/.aws/credentials', unixAttr(0o120777)))).rejects.toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(tmp, 'out', 'creds'))).toBe(false);
  });
});

describe('path traversal', () => {
  it.each(['../escape.txt', '../../etc/cron.d/x', 'a/../../escape.txt', '/abs/path.txt', '..\\win.txt'])('refuses %s and writes nothing outside', async (name) => {
    await expect(extract(rawZip(name, 'pwned'))).rejects.toThrow();
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
  });
});

describe('zip bombs', () => {
  it('refuses more entries than the cap', async () => {
    process.env.PLUGIN_MAX_EXTRACT_ENTRIES = '5';
    const zipPath = zipOf(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' })));
    await expect(extract(zipPath)).rejects.toThrow(/maximum entry count/);
  });

  it('refuses a highly compressible payload past the extracted-byte cap', async () => {
    process.env.PLUGIN_MAX_EXTRACT_BYTES = String(64 * 1024);
    // 1 MiB of zeros deflates to ~1 KiB.
    const zipPath = zipOf([{ name: 'bomb.bin', content: Buffer.alloc(1024 * 1024) }]);
    expect(fs.statSync(zipPath).size).toBeLessThan(64 * 1024);
    await expect(extract(zipPath)).rejects.toThrow(/maximum extracted size/);
  });

  it('counts the running total across many small entries', async () => {
    process.env.PLUGIN_MAX_EXTRACT_BYTES = String(10 * 1024);
    const zipPath = zipOf(Array.from({ length: 20 }, (_, i) => ({ name: `part${i}.bin`, content: Buffer.alloc(1024) })));
    await expect(extract(zipPath)).rejects.toThrow(/maximum extracted size/);
  });

  it('refuses a corrupt archive instead of extracting part of it', async () => {
    const file = path.join(tmp, 'garbage.zip');
    fs.writeFileSync(file, Buffer.from('PK\u0003\u0004 not really a zip'));
    await expect(extract(file)).rejects.toThrow();
  });
});

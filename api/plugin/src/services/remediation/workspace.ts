// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Working-copy helpers for the remediation engine: text-file trees, copies and ZIPs. */

import { createHash } from 'crypto';
import * as fs from 'fs';
import path from 'path';

import AdmZip from 'adm-zip';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'vendor', '__pycache__']);
/** Only text files up to this size are read into a tree (manifests, lockfiles, Dockerfiles). */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 10_000;

/** The context's text files (relative POSIX path → content). Binary and oversized files are left out. */
export function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.size >= MAX_FILES) return;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, relPath); continue; }
      if (!e.isFile()) continue;
      const size = fs.statSync(abs).size;
      if (size > MAX_TEXT_BYTES) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      out.set(relPath, buf.toString('utf8'));
    }
  };
  walk(root, '');
  return out;
}

/** Write every file of `tree` that differs from `before` into `root` (paths stay inside it). */
export function writeChanged(root: string, before: ReadonlyMap<string, string>, tree: ReadonlyMap<string, string>): void {
  const base = path.resolve(root);
  for (const [rel, content] of tree) {
    if (before.get(rel) === content) continue;
    const abs = path.resolve(base, rel);
    if (!abs.startsWith(base + path.sep)) throw new Error('path outside the build context');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  for (const rel of before.keys()) {
    if (tree.has(rel)) continue;
    const abs = path.resolve(base, rel);
    if (abs.startsWith(base + path.sep)) fs.rmSync(abs, { force: true });
  }
}

/** A fresh copy of `src` at `dest`. */
export function copyDir(src: string, dest: string): string {
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

/** ZIP a directory (the patched build context); returns the bytes and their SHA-256. */
export function zipDir(dir: string): { zip: Buffer; sha256: string } {
  const z = new AdmZip();
  z.addLocalFolder(dir);
  const zip = z.toBuffer();
  return { zip, sha256: createHash('sha256').update(zip).digest('hex') };
}

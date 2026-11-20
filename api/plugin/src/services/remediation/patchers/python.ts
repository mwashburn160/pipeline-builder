// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Python source patch: pin `<pkg>==<fixed>` where the context declares the
 * package — a requirements*.txt / constraints*.txt line (extras and markers
 * kept), or a `pip install` token in the Dockerfile (an `ARG X_VERSION` the
 * token reads is bumped instead). A package declared nowhere has no source
 * patch (the overlay upgrades it in place).
 */

import { argReference, bumpPinnedArg, findPinnedArg } from '../dockerfile.js';

import { baseName, isSafeToken, type SourcePatcher } from './types.js';

/** PEP 503 name normalization. */
export const normalizePyName = (n: string): string => n.toLowerCase().replace(/[-_.]+/g, '-');

const REQ_FILE = /^(?:requirements|constraints)[^/]*\.(?:txt|in)$/i;
const REQ_LINE = /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?(\s*[^;#]*?)(\s*;[^#]*)?(\s*#.*)?$/;

function pinRequirements(text: string, pkg: string, version: string): string | null {
  let changed = false;
  const lines = text.split('\n').map((line) => {
    if (/^\s*(?:#|-)/.test(line) || line.trim() === '') return line;
    const m = REQ_LINE.exec(line.replace(/\r$/, ''));
    if (!m || normalizePyName(m[2]!) !== pkg) return line;
    const next = `${m[1]}${m[2]}${m[3] ?? ''}==${version}${m[5] ?? ''}${m[6] ?? ''}`;
    if (next !== line) changed = true;
    return next;
  });
  return changed ? lines.join('\n') : null;
}

/** `pip install` tokens naming the package in the Dockerfile. */
function pinPipTokens(dockerfile: string, pkg: string, version: string): string | null {
  let out = dockerfile;
  let changed = false;
  const tokenRe = /(["']?)([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?(==|>=|~=|<=|!=|<|>)?([^\s"']*)\1/g;
  const lines = out.split('\n');
  let inPip = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b/.test(line)) inPip = true;
    if (inPip) {
      lines[i] = line.replace(tokenRe, (whole, q: string, name: string, extras: string | undefined, _op: string | undefined, ver: string) => {
        if (normalizePyName(name) !== pkg || name === 'install' || name === 'pip' || name === 'pip3') return whole;
        const ref = ver ? argReference(ver) : null;
        if (ref) {
          const arg = findPinnedArg(out, [ref]);
          if (arg) { out = bumpPinnedArg(out, arg, version); changed = true; }
          return whole;
        }
        changed = true;
        return `${q}${name}${extras ?? ''}==${version}${q}`;
      });
    }
    if (!/\\\s*$/.test(line)) inPip = false;
  }
  // ARG bumps edited `out` directly; token pins edited `lines`. Merge them.
  const merged = out.split('\n').map((l, i) => (lines[i] !== dockerfile.split('\n')[i] ? lines[i]! : l)).join('\n');
  return changed ? merged : null;
}

export const pythonPatcher: SourcePatcher = (tree, target, ctx) => {
  if (!isSafeToken(target.packageName) || !isSafeToken(target.fixVersion)) return null;
  const pkg = normalizePyName(target.packageName);
  const files = new Map<string, string>();
  for (const [path, text] of tree) {
    if (!REQ_FILE.test(baseName(path))) continue;
    const next = pinRequirements(text, pkg, target.fixVersion);
    if (next !== null) files.set(path, next);
  }
  const dockerfile = tree.get(ctx.dockerfile);
  if (dockerfile !== undefined) {
    const next = pinPipTokens(dockerfile, pkg, target.fixVersion);
    if (next !== null) files.set(ctx.dockerfile, next);
  }
  return files.size > 0 ? { purl: target.purl, packageType: 'python', files, regenerate: [], lockfiles: [] } : null;
};

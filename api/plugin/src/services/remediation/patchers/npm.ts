// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * npm source patch: an `overrides` entry (`"<pkg>": "<fixed>"`) in every
 * package.json of the context that a lockfile sits beside (or the root one),
 * then `npm install --package-lock-only --ignore-scripts` regenerates the
 * lockfile. Formatting (indent, trailing newline) is kept.
 */

import { baseName, dirOf, isSafeToken, joinPath, type SourcePatch, type SourcePatcher } from './types.js';

function indentOf(json: string): string | number {
  const m = /^\{\s*\n([ \t]+)"/.exec(json);
  return m ? m[1]! : 2;
}

/** The package.json files a fix belongs in (never under node_modules). */
function manifests(tree: ReadonlyMap<string, string>): string[] {
  const all = [...tree.keys()].filter((p) => baseName(p) === 'package.json' && !p.split('/').includes('node_modules'));
  const withLock = all.filter((p) => tree.has(joinPath(dirOf(p), 'package-lock.json')) || tree.has(joinPath(dirOf(p), 'npm-shrinkwrap.json')));
  if (withLock.length > 0) return withLock;
  return all.filter((p) => !p.includes('/')).slice(0, 1);
}

export const npmPatcher: SourcePatcher = (tree, target) => {
  if (!isSafeToken(target.packageName) || !isSafeToken(target.fixVersion)) return null;
  const files = new Map<string, string>();
  const patch: SourcePatch = { purl: target.purl, packageType: 'npm', files, regenerate: [], lockfiles: [] };
  for (const path of manifests(tree)) {
    const raw = tree.get(path)!;
    let json: Record<string, unknown>;
    try { json = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) continue;
    const overrides = (json.overrides && typeof json.overrides === 'object' && !Array.isArray(json.overrides)) ? json.overrides as Record<string, unknown> : {};
    if (overrides[target.packageName] === target.fixVersion) continue;
    json.overrides = { ...overrides, [target.packageName]: target.fixVersion };
    files.set(path, `${JSON.stringify(json, null, indentOf(raw))}${raw.endsWith('\n') ? '\n' : ''}`);
    const dir = dirOf(path);
    const lock = ['package-lock.json', 'npm-shrinkwrap.json'].find((l) => tree.has(joinPath(dir, l)));
    if (lock) {
      patch.regenerate.push({ ecosystem: 'npm', dir, command: 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund', outputs: [lock] });
      patch.lockfiles.push(joinPath(dir, lock));
    }
  }
  return files.size > 0 ? patch : null;
};

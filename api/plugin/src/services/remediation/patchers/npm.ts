// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * npm source patch: an `overrides` entry (`"<pkg>": "<fixed>"`) in every
 * package.json of the context that a lockfile sits beside (or the root one),
 * then `npm install --package-lock-only --ignore-scripts` regenerates the
 * lockfile. A package the manifest depends on DIRECTLY (dependencies, dev-,
 * optional-) gets the fixed version as that spec too: npm refuses an override
 * that differs from a direct dependency's spec (EOVERRIDE). Peer dependencies
 * are ranges a consumer satisfies, not installs, and are left alone.
 * Formatting (indent, trailing newline) is kept.
 */

import { baseName, dirOf, isSafeToken, joinPath, type SourcePatch, type SourcePatcher } from './types.js';

const DIRECT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

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
    const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const overrides = isMap(json.overrides) ? json.overrides : {};
    const direct = DIRECT_SECTIONS.filter((s) => isMap(json[s]) && (json[s] as Record<string, unknown>)[target.packageName] !== undefined);
    if (overrides[target.packageName] === target.fixVersion
      && direct.every((s) => (json[s] as Record<string, unknown>)[target.packageName] === target.fixVersion)) continue;
    for (const s of direct) json[s] = { ...(json[s] as Record<string, unknown>), [target.packageName]: target.fixVersion };
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

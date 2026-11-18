// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every NAME a consumer imports from an @pipeline-builder package entry is
 * actually exported by that entry.
 *
 * package-surface-contract.test.ts holds the subpath half (no consumer imports
 * a subpath the package does not export). This is the name half, and it exists
 * because of a real miss: `formatByteAmount` was dropped from
 * `@pipeline-builder/api-core/quota-catalog` as "unused", the api-core build
 * and tests stayed green, and only the frontend — which imports it — broke.
 * A package's own build cannot see its consumers, so the check lives here and
 * scans them all (frontend included).
 *
 * Source only (no build): each entry's exports come from its `src/` module via
 * the TypeScript checker, following `export *` / `export { } from` chains.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import ts from 'typescript';
import { REPO_ROOT } from '../src/index.js';

type Target = string | { types?: string; default?: string };
interface Manifest { name: string; exports?: Record<string, Target> }

const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const packages = new Map<string, { dir: string; manifest: Manifest }>(readdirSync(PACKAGES_DIR)
  .filter((d) => existsSync(join(PACKAGES_DIR, d, 'package.json')))
  .map((d) => [d, { dir: join(PACKAGES_DIR, d), manifest: JSON.parse(readFileSync(join(PACKAGES_DIR, d, 'package.json'), 'utf-8')) as Manifest }]));

/** `@pipeline-builder/<pkg>[/<sub>]` → the entry's `src/` module, from the exports map. */
const entrySources = new Map<string, string>();
for (const [short, { dir, manifest }] of packages) {
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (key === './package.json' || typeof target !== 'object' || !target.types) continue;
    const src = join(dir, target.types.replace(/^\.\/lib\//, 'src/').replace(/\.d\.ts$/, '.ts'));
    if (existsSync(src)) entrySources.set(`@pipeline-builder/${short}${key === '.' ? '' : key.slice(1)}`, src);
  }
}

// -- consumers' named imports --------------------------------------------------

const SCAN_ROOTS = ['api', 'platform', 'packages', 'frontend', 'deploy', 'scripts', 'test'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'test-reports', '.docker-build', '.projen']);
const BUILD_DIRS = new Set(['lib', 'dist', 'out']);
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (BUILD_DIRS.has(name) && existsSync(join(dir, 'package.json'))) continue;
      walk(full, out);
    } else if (CODE_EXT.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

interface NamedImport { file: string; spec: string; name: string }

function namedImportsIn(file: string, text: string): NamedImport[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: NamedImport[] = [];
  const rel = relative(REPO_ROOT, file);
  for (const stmt of sf.statements) {
    const specNode = (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) ? stmt.moduleSpecifier : undefined;
    if (!specNode || !ts.isStringLiteral(specNode) || !entrySources.has(specNode.text)) continue;
    const spec = specNode.text;
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name) out.push({ file: rel, spec, name: 'default' });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) out.push({ file: rel, spec, name: (el.propertyName ?? el.name).text });
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) out.push({ file: rel, spec, name: (el.propertyName ?? el.name).text });
    }
  }
  return out;
}

const imports: NamedImport[] = [];
for (const root of SCAN_ROOTS) {
  const abs = join(REPO_ROOT, root);
  if (!existsSync(abs)) continue;
  const files: string[] = [];
  walk(abs, files);
  for (const f of files) {
    const text = readFileSync(f, 'utf-8');
    if (text.includes('@pipeline-builder/')) imports.push(...namedImportsIn(f, text));
  }
}

// -- what each entry exports -----------------------------------------------------

let cached: Map<string, Set<string>> | undefined;
function entryExports(): Map<string, Set<string>> {
  if (cached) return cached;
  const roots = [...new Set(entrySources.values())];
  const program = ts.createProgram(roots, {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const out = new Map<string, Set<string>>();
  for (const [spec, src] of entrySources) {
    const sf = program.getSourceFile(src);
    const sym = sf && checker.getSymbolAtLocation(sf);
    out.set(spec, new Set(sym ? checker.getExportsOfModule(sym).map((s) => s.name) : []));
  }
  cached = out;
  return out;
}

describe('consumers import only names their @pipeline-builder entry exports', () => {
  it('scans consumers across the repo, the frontend included', () => {
    expect(imports.length).toBeGreaterThan(100);
    expect(imports.some((i) => i.file.startsWith('frontend/'))).toBe(true);
  });

  it('resolves a non-empty export list for every entry a consumer imports from', () => {
    const exportsBySpec = entryExports();
    const empty = [...new Set(imports.map((i) => i.spec))].filter((s) => (exportsBySpec.get(s)?.size ?? 0) === 0);
    expect(empty).toEqual([]);
  });

  it('has no import of a name the entry does not export (a removed export a consumer still uses)', () => {
    const exportsBySpec = entryExports();
    const missing = imports
      .filter((i) => !exportsBySpec.get(i.spec)!.has(i.name))
      .map((i) => `${i.file}: { ${i.name} } from '${i.spec}'`);
    expect([...new Set(missing)]).toEqual([]);
  });
});

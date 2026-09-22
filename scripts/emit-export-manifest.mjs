#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Emit `lib/testing/exports.json` for the workspace package in the current
 * directory: the RUNTIME export names of each of its entry points, with a kind
 * (`function` / `class` / `value`) per name.
 *
 * It is the input to api-core's `stubModule(specifier, overrides)`
 * (packages/api-core/src/testing/stub-module.ts), which turns every listed
 * export into a loud stub unless a suite overrides it — so a module mock can
 * never again go stale against the real barrel and fail to link with
 * "does not provide an export named X".
 *
 * Read from the BUILT declarations (lib/*.d.ts) with the TypeScript checker,
 * not by importing lib/index.js: importing a barrel runs its side effects
 * (config validation, DB/Redis wiring), and the declarations already carry
 * exactly which names are values. Type-only exports are omitted — they do not
 * exist at runtime, so a module mock must not (and cannot) provide them.
 *
 * Runs from each package's `post-compile` task (see projenrc/package.ts).
 *
 * Usage (from a package directory):
 *   node ../../scripts/emit-export-manifest.mjs           # write lib/testing/exports.json
 *   node ../../scripts/emit-export-manifest.mjs --check   # fail if it is stale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const cwd = process.cwd();
const pkgJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
// The package's OWN typescript (the workspace pins it per project).
const ts = createRequire(join(cwd, 'package.json'))('typescript');

/** Entry subpath → declaration file, from `exports` (or `types` for the root). */
function entryDeclarations() {
  const entries = {};
  const exp = pkgJson.exports;
  if (exp && typeof exp === 'object') {
    for (const [sub, target] of Object.entries(exp)) {
      if (sub.includes('*') || sub === './package.json') continue;
      const types = typeof target === 'object' && target ? target.types : undefined;
      if (typeof types === 'string' && types.endsWith('.d.ts')) entries[sub] = types;
    }
  } else if (typeof pkgJson.types === 'string') {
    entries['.'] = pkgJson.types;
  }
  return entries;
}

/** Classify one exported symbol, or `undefined` when it is type-only. */
function kindOf(checker, symbol) {
  let target = symbol;
  if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
  const f = target.flags;
  if (!(f & ts.SymbolFlags.Value)) return undefined;
  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & ts.SymbolFlags.Variable) {
    const decl = target.valueDeclaration ?? target.declarations?.[0];
    if (decl) {
      const type = checker.getTypeOfSymbolAtLocation(target, decl);
      if (type.getConstructSignatures().length > 0) return 'class';
      if (type.getCallSignatures().length > 0) return 'function';
    }
  }
  return 'value';
}

const decls = entryDeclarations();
const files = Object.values(decls).map((p) => resolve(cwd, p));
const missing = files.filter((f) => !existsSync(f));
if (missing.length) {
  console.error(`emit-export-manifest: ${pkgJson.name}: missing declaration(s) ${missing.join(', ')} — compile first.`);
  process.exit(1);
}

const program = ts.createProgram(files, {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext,
  skipLibCheck: true,
  noEmit: true,
  types: [],
});
const checker = program.getTypeChecker();

const entries = {};
for (const [sub, rel] of Object.entries(decls)) {
  const sf = program.getSourceFile(resolve(cwd, rel));
  const moduleSymbol = sf && checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) {
    console.error(`emit-export-manifest: ${pkgJson.name}: '${rel}' is not a module.`);
    process.exit(1);
  }
  const names = {};
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    const kind = kindOf(checker, sym);
    if (kind) names[sym.getName()] = kind;
  }
  entries[sub] = Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)));
}

const manifest = `${JSON.stringify({ package: pkgJson.name, entries }, null, 2)}\n`;
const outDir = join(cwd, 'lib', 'testing');
const outFile = join(outDir, 'exports.json');

if (process.argv.includes('--check')) {
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  if (current !== manifest) {
    console.error(`emit-export-manifest: ${outFile} is stale — rerun compile.`);
    process.exit(1);
  }
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, manifest);
  const count = Object.values(entries).reduce((n, e) => n + Object.keys(e).length, 0);
  console.log(`emit-export-manifest: ${pkgJson.name}: ${count} runtime exports across ${Object.keys(entries).length} entr${Object.keys(entries).length === 1 ? 'y' : 'ies'}.`);
}

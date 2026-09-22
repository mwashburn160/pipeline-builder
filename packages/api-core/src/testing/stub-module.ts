// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest-driven module stubs for `jest.unstable_mockModule`.
 *
 * WHY: `unstable_mockModule(spec, factory)` replaces the WHOLE namespace. A
 * factory returning a hand-written object literal therefore exports only the
 * keys somebody remembered to list, and the day production code imports one
 * more name every suite mocking that module fails to link with
 * "does not provide an export named X" — a break with no relationship to the
 * change that caused it. That happened repeatedly with the api-server,
 * pipeline-data and pipeline-core literals.
 *
 * THE FIX: every workspace package emits `lib/testing/exports.json` at compile
 * time (scripts/emit-export-manifest.mjs, run from each package's
 * `post-compile`) — the runtime export names of each entry point, read off the
 * built declarations. `stubModule` returns EVERY export in that manifest:
 * the ones a suite overrides get the override, the rest are LOUD stubs —
 * a function/class that throws when called or constructed, or an object that
 * throws when a property is read. A new export can never break linking again,
 * and a SUT that reaches for something the suite did not provide fails with a
 * message naming the export instead of an `undefined is not a function`.
 *
 * USAGE:
 *   import { stubModule } from '@pipeline-builder/api-core/testing';
 *   jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
 *     withRoute: jest.fn(),
 *   }));
 *
 * An override key the manifest does not know is an error: it is either a typo
 * or a name the real module no longer exports, and the suite is lying either way.
 *
 * Imported through the `@pipeline-builder/api-core/testing` entry, so a suite's `@pipeline-builder/api-core`
 * mock never intercepts it. Depends only on node builtins.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** How an export is stubbed: callable, constructible, or a plain value. */
export type ExportKind = 'function' | 'class' | 'value';

/** `lib/testing/exports.json` — one export map per package entry point. */
export interface ExportManifest {
  /** The package name, e.g. `@pipeline-builder/api-server`. */
  package: string;
  /** Entry subpath (`.`, `./cdk`, …) → export name → kind. */
  entries: Record<string, Record<string, ExportKind>>;
}

const manifestCache = new Map<string, ExportManifest>();

/** Tuning for {@link stubModule}. */
export interface StubModuleOptions {
  /**
   * What to do with an override the real module does not export.
   *  - `'error'` (default): throw — it is a typo or a stale name.
   *  - `'drop'`: leave it out of the stub, exactly as the real barrel would.
   *    For suites that ASSEMBLE the module from its real internal files
   *    (`{ ...await import('<pkg>/lib/api/crud-service.js'), … }`): those carry
   *    internals the barrel deliberately does not re-export.
   */
  extraOverrides?: 'error' | 'drop';
}

/**
 * Split `@scope/name/sub/path` into the package name and the entry subpath
 * (`.` for the root entry).
 */
function splitSpecifier(specifier: string): { pkg: string; entry: string } {
  const parts = specifier.split('/');
  const nameParts = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  const rest = parts.slice(nameParts.length);
  return { pkg: nameParts.join('/'), entry: rest.length ? `./${rest.join('/')}` : '.' };
}

/**
 * Load a package's export manifest. Resolved from the CURRENT project
 * (`process.cwd()`, which jest sets to the project root) so api-core can find
 * the manifest of a package it does not itself depend on.
 */
export function loadExportManifest(pkg: string, fromDir: string = process.cwd()): ExportManifest {
  const key = `${fromDir}\0${pkg}`;
  const cached = manifestCache.get(key);
  if (cached) return cached;
  const req = createRequire(join(fromDir, 'package.json'));
  let pkgJsonPath: string;
  try {
    pkgJsonPath = req.resolve(`${pkg}/package.json`);
  } catch (err) {
    throw new Error(`stubModule: cannot resolve '${pkg}' from ${fromDir}: ${(err as Error).message}`);
  }
  const manifestPath = join(dirname(pkgJsonPath), 'lib', 'testing', 'exports.json');
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest;
  } catch (err) {
    throw new Error(`stubModule: no export manifest at ${manifestPath} — build '${pkg}' first (its post-compile emits it): ${(err as Error).message}`);
  }
  manifestCache.set(key, manifest);
  return manifest;
}

/** Property reads a loud value-stub still answers, so jest / util.inspect can print it. */
const INSPECTION_KEYS = new Set<PropertyKey>(['then', 'asymmetricMatch', '$$typeof', 'nodeType', 'toJSON', 'constructor', '@@__IMMUTABLE_ITERABLE__@@', '@@__IMMUTABLE_RECORD__@@']);

function notOverridden(specifier: string, name: string, how: string): Error {
  return new Error(
    `stubModule('${specifier}'): export '${name}' was ${how} but the suite did not override it. `
    + 'Pass it in stubModule\'s overrides (or spread the real module) if the code under test needs it.',
  );
}

function loudStub(specifier: string, name: string, kind: ExportKind): unknown {
  if (kind === 'value') {
    return new Proxy(Object.create(null) as object, {
      get(_t, prop) {
        if (typeof prop === 'symbol' || INSPECTION_KEYS.has(prop)) return undefined;
        throw notOverridden(specifier, `${name}.${String(prop)}`, 'read');
      },
      has() { return false; },
      ownKeys() { return []; },
    });
  }
  // A named function (not an arrow) so `new` works, `instanceof` against it is
  // a harmless `false`, and a stack trace names the export.
  const stub = {
    [name]: function () {
      throw notOverridden(specifier, name, kind === 'class' ? 'called/constructed' : 'called');
    },
  }[name];
  return stub;
}

/**
 * Every export of `specifier` (per its manifest) as a loud stub, with
 * `overrides` layered on top.
 *
 * @param manifest  the module specifier (`@pipeline-builder/pipeline-data`,
 *                  `@pipeline-builder/pipeline-core/cdk`) or an already-loaded
 *                  manifest plus the entry to use.
 * @param overrides the exports the suite actually provides.
 * @param options   see {@link StubModuleOptions}.
 */
export function stubModule<T extends Record<string, unknown>>(
  manifest: string | { manifest: ExportManifest; entry?: string },
  overrides: T = {} as T,
  options: StubModuleOptions = {},
): Record<string, unknown> & T {
  let resolved: ExportManifest;
  let entry: string;
  let specifier: string;
  if (typeof manifest === 'string') {
    const split = splitSpecifier(manifest);
    resolved = loadExportManifest(split.pkg);
    entry = split.entry;
    specifier = manifest;
  } else {
    resolved = manifest.manifest;
    entry = manifest.entry ?? '.';
    specifier = entry === '.' ? resolved.package : `${resolved.package}/${entry.slice(2)}`;
  }
  const exportsOfEntry = resolved.entries[entry];
  if (!exportsOfEntry) {
    throw new Error(`stubModule: '${resolved.package}' has no entry '${entry}' in its export manifest (entries: ${Object.keys(resolved.entries).join(', ')})`);
  }
  const unknown = Object.keys(overrides).filter((k) => !Object.hasOwn(exportsOfEntry, k));
  if (unknown.length && options.extraOverrides !== 'drop') {
    throw new Error(`stubModule('${specifier}'): override(s) ${unknown.map((k) => `'${k}'`).join(', ')} are not exports of the real module — a typo, or a name it no longer exports.`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(exportsOfEntry)) {
    out[name] = Object.hasOwn(overrides, name) ? overrides[name] : loudStub(specifier, name, kind);
  }
  return out as Record<string, unknown> & T;
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The published surface of every @pipeline-builder package is its `exports`
 * map — and nothing else.
 *
 * Every package under packages/ publishes to npm. A package with no `exports`
 * map (or one with a `./lib/*` wildcard) makes EVERY compiled file importable,
 * so each internal module silently becomes public API that a minor release
 * cannot change. The maps are therefore explicit (setPublicSurface in
 * .projenrc.ts), and this suite holds the two halves of that contract:
 *
 *   1. The maps themselves: no wildcard, `./package.json` present, every target
 *      a compiled entry whose source exists, and every PUBLISHED target (the
 *      `publishConfig.exports` override, when there is one) actually shipped —
 *      not stripped from the tarball by the package's .npmignore.
 *   2. The consumers: no source file in the repo imports a subpath the target
 *      package does not export. The ONE exception is a unit test deep-importing
 *      `@pipeline-builder/<lib>/lib/<path>`, which resolves only through the
 *      workspace jest/tsconfig mapping (WORKSPACE_LIBS in
 *      projenrc/shared-config.ts) and never through `exports`. Production code
 *      that needs an internal gets a named entry or a barrel export instead.
 *
 * It reads source and manifests only (no build needed). The post-compile
 * `scripts/check-package-surface.mjs` is the built-artifact half: it asserts
 * each target exists in lib/ once compiled.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import { REPO_ROOT } from '../src/index.js';

type Target = string | { types?: string; default?: string; [cond: string]: unknown };
interface Manifest {
  name: string;
  exports?: Record<string, Target>;
  publishConfig?: { exports?: Record<string, Target> };
}

/** Must match WORKSPACE_LIBS in projenrc/shared-config.ts. */
const WORKSPACE_LIBS = ['api-core', 'api-server', 'pipeline-core', 'pipeline-data', 'ai-core', 'pipeline-events'];

const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const packages: Array<{ dir: string; short: string; manifest: Manifest }> = readdirSync(PACKAGES_DIR)
  .filter((d) => existsSync(join(PACKAGES_DIR, d, 'package.json')))
  .map((d) => ({ dir: join(PACKAGES_DIR, d), short: d, manifest: JSON.parse(readFileSync(join(PACKAGES_DIR, d, 'package.json'), 'utf-8')) as Manifest }));
const byShort = new Map(packages.map((p) => [p.short, p]));

function targetPaths(t: Target): string[] {
  if (typeof t === 'string') return [t];
  return Object.values(t).filter((v): v is string => typeof v === 'string');
}

/** The compiled `lib/x.js` / `lib/x.d.ts` → its `src/x.ts` source. */
function sourceOf(target: string): string {
  return target.replace(/^\.\/lib\//, 'src/').replace(/\.d\.ts$/, '.ts').replace(/\.js$/, '.ts');
}

describe('package exports maps', () => {
  it('finds the published packages', () => {
    expect(packages.map((p) => p.short).sort()).toEqual(
      ['ai-core', 'api-core', 'api-server', 'pipeline-core', 'pipeline-data', 'pipeline-events', 'pipeline-manager'],
    );
  });

  for (const { short, dir, manifest } of packages) {
    describe(short, () => {
      const exportsMap = manifest.exports ?? {};

      it('declares an explicit exports map with ./package.json and no wildcard', () => {
        expect(manifest.exports).toBeDefined();
        expect(exportsMap['./package.json']).toBe('./package.json');
        for (const [key, target] of Object.entries(exportsMap)) {
          expect(key).not.toContain('*');
          for (const p of targetPaths(target)) expect(p).not.toContain('*');
        }
      });

      it('points every entry at a compiled lib/ file whose source exists', () => {
        for (const [key, target] of Object.entries(exportsMap)) {
          if (key === './package.json') continue;
          expect(typeof target).toBe('object');
          const { types, default: impl } = target as { types?: string; default?: string };
          expect(types).toMatch(/^\.\/lib\/.+\.d\.ts$/);
          expect(impl).toMatch(/^\.\/lib\/.+\.js$/);
          expect(sourceOf(impl!)).toBe(sourceOf(types!));
          expect({ key, exists: existsSync(join(dir, sourceOf(impl!))) }).toEqual({ key, exists: true });
        }
      });

      it('publishes only entries the tarball ships', () => {
        const published = manifest.publishConfig?.exports ?? exportsMap;
        for (const [key, target] of Object.entries(published)) {
          expect(exportsMap[key]).toEqual(target);
        }
        const ignored = existsSync(join(dir, '.npmignore'))
          ? readFileSync(join(dir, '.npmignore'), 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/lib/'))
          : [];
        for (const [key, target] of Object.entries(published)) {
          for (const p of targetPaths(target)) {
            const stripped = ignored.find((rule) => `/${p.replace(/^\.\//, '')}`.startsWith(rule));
            expect({ key, strippedBy: stripped }).toEqual({ key, strippedBy: undefined });
          }
        }
      });
    });
  }
});

// -- consumers ---------------------------------------------------------------

const SCAN_ROOTS = ['api', 'platform', 'packages', 'frontend', 'deploy', 'scripts', 'test'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'test-reports', '.docker-build', '.projen']);
/** Build output: a `lib/` or `dist/` sitting next to its project's package.json (not, say, frontend/src/lib). */
const BUILD_DIRS = new Set(['lib', 'dist', 'out']);
const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (BUILD_DIRS.has(name) && existsSync(join(dir, 'package.json'))) continue;
      walk(full, out);
    } else if (CODE_EXT.test(name) || name === 'Dockerfile' || name === 'package.json') {
      out.push(full);
    }
  }
}

/** Test infrastructure — the only code allowed the workspace-only internals mapping. */
function isTestFile(rel: string): boolean {
  return /(^|\/)(test|__tests__)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /\/src\/testing\//.test(rel);
}

// Module specifiers in import position: static/dynamic import, export-from,
// require, jest module mocks, and `node --import <spec>` (Dockerfile CMDs and
// package.json start scripts). Strings in comments or doc text are not imports.
const SPECIFIER_PATTERNS = [
  /\b(?:from|import)\s*\(?\s*['"`](@pipeline-builder\/[^'"`\s]+)['"`]/g,
  /\brequire\s*\(\s*['"`](@pipeline-builder\/[^'"`\s]+)['"`]/g,
  /\b(?:unstable_mockModule|mock|requireActual|importActual|stubModule)\s*\(\s*['"`](@pipeline-builder\/[^'"`\s]+)['"`]/g,
  /--import[\s=",]+(@pipeline-builder\/[^'"`\s,\]]+)/g,
];

function specifiersIn(text: string): string[] {
  const found: string[] = [];
  for (const re of SPECIFIER_PATTERNS) for (const m of text.matchAll(re)) found.push(m[1]!);
  return found;
}

describe('consumers import only exported subpaths', () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (existsSync(abs)) walk(abs, files);
  }

  it('scans the repo', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no deep or unexported import', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      // This suite's own patterns quote example specifiers.
      if (rel === 'test/deploy-contracts/test/package-surface-contract.test.ts') continue;
      const testFile = isTestFile(rel);
      for (const spec of specifiersIn(readFileSync(file, 'utf-8'))) {
        const m = /^@pipeline-builder\/([a-z-]+)(?:\/(.*))?$/.exec(spec);
        if (!m) continue;
        const pkg = byShort.get(m[1]!);
        if (!pkg) continue; // not a published package (e.g. a service name)
        const sub = m[2] ? `./${m[2]}` : '.';
        if (sub === '.' && pkg.manifest.exports?.['.']) continue;
        if (sub.startsWith('./lib/')) {
          if (testFile && WORKSPACE_LIBS.includes(m[1]!)) continue;
          violations.push(`${rel}: ${spec} (deep import — production code must use an exports entry)`);
          continue;
        }
        const workspaceMap = pkg.manifest.exports ?? {};
        const publishedMap = pkg.manifest.publishConfig?.exports ?? workspaceMap;
        // Workspace-only entries (./testing) are for test code; production
        // code needs an entry the published package actually carries.
        const allowed = testFile ? workspaceMap : publishedMap;
        if (!(sub in allowed)) violations.push(`${rel}: ${spec} (not in ${pkg.manifest.name}'s ${testFile ? '' : 'published '}exports map)`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';

/**
 * Shared TypeScript Compiler Options
 *
 * Base strict compiler options shared across all project types in the monorepo.
 * Each project class imports and spreads these, overriding only what differs
 * (outDir, module format, target, etc.).
 */

/**
 * Strict TypeScript compiler options used by all project types.
 *
 * Includes:
 * - All strict type checking flags
 * - Source maps and declaration output
 * - ES module interop and JSON support
 * - Decorators and build behavior defaults
 */
export const BASE_STRICT_COMPILER_OPTIONS = {
    // Source directory (all projects use 'src')
    rootDir: 'src',

    // Strict type checking
    alwaysStrict: true,
    strict: true,
    strictNullChecks: true,
    strictPropertyInitialization: true,
    noImplicitAny: true,
    noImplicitReturns: true,
    noImplicitThis: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noFallthroughCasesInSwitch: true,

    // Type declarations and source maps
    declaration: true,
    inlineSourceMap: true,
    inlineSources: true,

    // ES Module interop and JSON support
    esModuleInterop: true,
    resolveJsonModule: true,

    // Decorators support
    experimentalDecorators: true,

    // Build behavior
    skipLibCheck: true,
} as const;

/**
 * ESM-only compiler options (NOT for the CommonJS pipeline-manager, where
 * verbatimModuleSyntax would demand `import x = require()` everywhere). Each
 * file transpiles in isolation so ts-jest can run transpile-only (far faster
 * suites); verbatimModuleSyntax forces explicit `import type` so the transpiler
 * can elide type-only imports without cross-file type info.
 */
export const ESM_COMPILER_OPTIONS = {
    isolatedModules: true,
    verbatimModuleSyntax: true,
} as const;

/** Structural shape of a projen project we mutate for jest. */
interface JestConfigurable {
    outdir: string;
    package: { addField: (k: string, v: unknown) => void };
    deps: { removeDependency: (name: string) => void };
    addDevDeps: (...deps: string[]) => void;
    jest?: { config: Record<string, unknown> };
    tasks: { tryFind: (n: string) => { env: (k: string, v: string) => void } | undefined };
}

// ESM relative imports carry explicit `.js` extensions; strip them so ts-jest
// resolves the `.ts` source.
const JS_EXT_MAP = { '^(\\.{1,2}/.*)\\.js$': '$1' };

/**
 * uuid v13+ ships ESM-only; map it to the repo-root CJS stub so jest can import
 * it. The `../` depth is derived from the project's own depth (platform/frontend
 * sit one level under the root, packages/* and api/* two), since the stub lives
 * at the repo root — a fixed `../../` is wrong for one-deep projects.
 */
function uuidStub(project: JestConfigurable): Record<string, string> {
    const toRoot = path.relative(project.outdir, process.cwd()) || '.';
    return { '^uuid$': `<rootDir>/${toRoot}/jest-uuid-stub.js` };
}

/**
 * Shared ts-jest transform. Every package is ESM, so `useESM` is always on.
 * `isolatedModules` lives in tsconfig (ESM_COMPILER_OPTIONS) — paired with
 * `verbatimModuleSyntax` (which forces explicit `import type`) it lets ts-jest
 * run transpile-only, for much faster suites.
 */
function tsJestTransform(): Record<string, unknown> {
    return {
        '^.+\\.[t]sx?$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.dev.json', diagnostics: { ignoreCodes: [151002] } }],
    };
}

/**
 * Configure an ESM package: package.json `"type": "module"`, ts-jest in ESM mode,
 * and `--experimental-vm-modules`. Tests import their globals from `@jest/globals`
 * and mock with `jest.unstable_mockModule`, so `@types/jest` (which lags jest and
 * has no 30.4.x) is dropped and `@jest/globals` declared in its place. Every
 * package in the monorepo is ESM and runs through here. (Per-project maxWorkers is
 * set explicitly in .projenrc.ts where needed.)
 */
export function configureEsmJest(project: JestConfigurable): void {
    project.package.addField('type', 'module');
    project.deps.removeDependency('@types/jest');
    // ESM suites import their globals from `@jest/globals`; declare it so pnpm
    // links it into the package (jest injects it at runtime, but eslint's
    // import/no-unresolved resolves statically against node_modules and would
    // otherwise fail on every test file).
    project.addDevDeps('@jest/globals@30.2.0');
    if (project.jest) {
        project.jest.config.extensionsToTreatAsEsm = ['.ts', '.tsx'];
        project.jest.config.transform = tsJestTransform();
        project.jest.config.moduleNameMapper = { ...uuidStub(project), ...JS_EXT_MAP };
    }
    project.tasks.tryFind('test')?.env('NODE_OPTIONS', '--experimental-vm-modules');
}

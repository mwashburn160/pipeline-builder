// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import type { Tasks } from 'projen';

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
    tasks: Tasks;
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
        // projen 0.103 generates the test-scoped tsconfig at `test/tsconfig.json`
        // (it used to be `tsconfig.dev.json`); ts-jest resolves this from the
        // package root, and only reads its compilerOptions.
        '^.+\\.[t]sx?$': ['ts-jest', { useESM: true, tsconfig: 'test/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
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
    project.addDevDeps('@jest/globals@30.4.1');
    // TS7 dual-package: `typescript` is aliased to the 6.x-compatible package (so
    // ts-jest's ConfigSet keeps the classic API and doesn't crash), while the real
    // TS7 native compiler is installed as `@typescript/native`. ts-jest pinned to
    // the latest 29.4.x alongside.
    project.addDevDeps('@typescript/native@npm:typescript@^7.0.2', 'ts-jest@29.4.12');
    if (project.jest) {
        project.jest.config.extensionsToTreatAsEsm = ['.ts', '.tsx'];
        project.jest.config.transform = tsJestTransform();
        project.jest.config.moduleNameMapper = { ...uuidStub(project), ...JS_EXT_MAP };
        // `clearMocks` (projen's default) only resets calls — it leaves a
        // `jest.spyOn(...).mockImplementation(...)` in place for every later test
        // in the file AND, for a spy on a shared module object, for every later
        // file in the worker. `restoreMocks` puts the original implementation
        // back after each test, so a spy can't leak past the test that set it.
        project.jest.config.restoreMocks = true;
        // `process.env` is the one piece of state jest cannot reset for us: a
        // worker runs many test FILES in one process. Snapshot + restore it per
        // file so a suite that sets an env var can't change how the NEXT file
        // behaves. See jest-env-guard.js at the repo root.
        const existingSetup = (project.jest.config.setupFilesAfterEnv as string[] | undefined) ?? [];
        project.jest.config.setupFilesAfterEnv = [
            ...existingSetup,
            `<rootDir>/${path.relative(project.outdir, process.cwd()) || '.'}/jest-env-guard.js`,
        ];
    }
    project.tasks.tryFind('test')?.env('NODE_OPTIONS', '--experimental-vm-modules');
    // Type-check the TEST tree. ts-jest runs transpile-only (isolatedModules), and
    // `compile` only covers src/, so a suite calling a function with the wrong
    // signature, or a mock whose shape drifted from the real module, used to pass
    // CI silently — 3,800 such errors had accumulated. `test` spawns this first,
    // so `build` (the gate) fails on ANY test type error: zero, not a ratchet.
    const typecheckTests = project.tasks.addTask('typecheck:tests', {
        description: 'Type-check the test tree (test/tsconfig.json) with zero errors',
        exec: 'tsc --noEmit -p test/tsconfig.json',
    });
    project.tasks.tryFind('test')?.prependSpawn(typecheckTests);
    // `test:update` (jest --updateSnapshot) runs the same ESM suites.
    project.tasks.tryFind('test:update')?.env('NODE_OPTIONS', '--experimental-vm-modules');
}

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

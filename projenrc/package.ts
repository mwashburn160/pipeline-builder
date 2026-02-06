/**
 * Package Project Configuration
 *
 * This module defines the base configuration for library packages in the monorepo.
 * Used for packages that are published and consumed by other packages or services.
 *
 * Package projects are characterized by:
 * - ES Module format (NodeNext) for modern Node.js compatibility
 * - Type declarations for TypeScript consumers
 * - Strict type checking and compiler options
 * - Source maps for debugging
 * - Located in ./packages directory
 *
 * Examples of package projects:
 * - api-core: Shared API utilities
 * - api-server: Express server infrastructure
 * - pipeline-data: Database layer
 * - pipeline-core: CDK constructs and configuration
 *
 * @see TypeScriptProject from projen for base functionality
 */

import { execSync } from 'node:child_process';
import { TypeScriptModuleResolution } from 'projen/lib/javascript';
import { TypeScriptProject, TypeScriptProjectOptions } from 'projen/lib/typescript';

/**
 * Base class for library package projects.
 *
 * Extends TypeScriptProject with strict compiler options and
 * modern ES module configuration suitable for Node.js packages.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * let apiCore = new PackageProject({
 *   parent: root,
 *   name: '@mwashburn160/api-core',
 *   outdir: './packages/api-core',
 *   deps: ['express', 'winston'],
 * });
 * ```
 */
export class PackageProject extends TypeScriptProject {

    /**
     * Creates a new package project with strict TypeScript configuration.
     *
     * @param options - TypeScript project options
     */
    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            tsconfig: {
                compilerOptions: {
                    // Source and output directories
                    rootDir: 'src',
                    outDir: 'lib',

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

                    // Module configuration (ES Modules with Node.js support)
                    module: TypeScriptModuleResolution.NODE_NEXT,
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
                    target: 'ESNext',
                    lib: ['ESNext'],

                    // Type declarations and source maps
                    declaration: true,
                    inlineSourceMap: true,
                    inlineSources: true,

                    // ES Module interop and JSON support
                    esModuleInterop: true,
                    resolveJsonModule: true,

                    // Decorators support (for future use)
                    experimentalDecorators: true,

                    // Build behavior
                    noEmitOnError: false,        // Continue build even with errors
                    stripInternal: true,         // Remove @internal declarations
                    skipLibCheck: true           // Skip lib.d.ts checks for faster builds
                }
            }
        })
    }

    /**
     * Runs before synthesis to ensure output directory exists.
     * This prevents errors when generating project files.
     */
    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

    /**
     * Runs after synthesis to clean up test directories.
     * Test directories are managed separately and not part of the build output.
     */
    postSynthesize(): void {
        execSync(`if [ -d ${this.outdir}/test ];then rm -rf ${this.outdir}/test;fi`)
    }
}
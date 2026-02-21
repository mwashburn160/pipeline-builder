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
import { BASE_STRICT_COMPILER_OPTIONS } from './shared-config';

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
                    ...BASE_STRICT_COMPILER_OPTIONS,
                    outDir: 'lib',

                    // Module configuration (ES Modules with Node.js support)
                    module: TypeScriptModuleResolution.NODE_NEXT,
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
                    target: 'ESNext',
                    lib: ['ESNext'],

                    // Build behavior
                    noEmitOnError: false,
                    stripInternal: true,
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

}
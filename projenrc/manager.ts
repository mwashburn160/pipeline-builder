// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manager CLI Project Configuration
 *
 * This module defines the configuration for the pipeline-manager CLI tool.
 * This is an application project (not a library) designed to be run as a command.
 *
 * CLI Tool Characteristics:
 * - ES Module format (NodeNext), matching every other package in the monorepo
 * - Executable binary in package.json
 * - Outputs to 'dist' directory
 * - ES2024 target for modern JavaScript features
 * - Includes configuration files (cdk.json, config.yml) in dist
 *
 * The pipeline-manager CLI provides:
 * - Interactive pipeline creation and deployment
 * - Plugin upload and management
 * - AWS CDK stack operations
 * - Progress tracking and status updates
 *
 * @see TypeScriptAppProject from projen for application projects
 */

import { execSync } from 'node:child_process'
import { TypeScriptModuleResolution } from 'projen/lib/javascript';
import { TypeScriptAppProject, TypeScriptProjectOptions } from 'projen/lib/typescript';
import { BASE_STRICT_COMPILER_OPTIONS, ESM_COMPILER_OPTIONS, configureEsmJest } from './shared-config';

/**
 * CLI application project for pipeline management.
 *
 * Extends TypeScriptAppProject with CommonJS module format
 * and strict type checking suitable for a command-line tool.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * let manager = new ManagerProject({
 *   parent: root,
 *   name: '@pipeline-builder/pipeline-manager',
 *   outdir: './packages/pipeline-manager',
 *   bin: { 'pipeline-manager': './dist/cli.js' },
 * });
 * ```
 */
export class ManagerProject extends TypeScriptAppProject {

    /**
     * Creates a new manager CLI project with application-specific configuration.
     *
     * @param options - TypeScript project options
     */
    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            tsconfig: {
                compilerOptions: {
                    ...BASE_STRICT_COMPILER_OPTIONS,
                    ...ESM_COMPILER_OPTIONS,
                    outDir: 'dist',

                    // Module configuration (ES Modules with Node.js support),
                    // matching every other package in the monorepo.
                    module: TypeScriptModuleResolution.NODE_NEXT,
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
                    target: 'ES2024',
                    lib: ['ES2024'],

                    // Additional strict checks
                    noUncheckedIndexedAccess: true,

                    // Additional options
                    declarationMap: true,
                    allowJs: true,
                    forceConsistentCasingInFileNames: true,
                    // ESM suites import globals from `@jest/globals` (configured by
                    // configureEsmJest), so the ambient `jest` types are dropped.
                    types: ['node'],
                },

                include: ['src/*'],
                exclude: ['dist', 'node_modules'],
            }
        })
        configureEsmJest(this);
    }

    /**
     * Runs before synthesis to ensure output directory exists.
     */
    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

}
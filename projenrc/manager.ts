/**
 * Manager CLI Project Configuration
 *
 * This module defines the configuration for the pipeline-manager CLI tool.
 * This is an application project (not a library) designed to be run as a command.
 *
 * CLI Tool Characteristics:
 * - CommonJS module format for maximum Node.js compatibility
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
import { TypeScriptAppProject, TypeScriptProjectOptions } from 'projen/lib/typescript';
import { BASE_STRICT_COMPILER_OPTIONS } from './shared-config';

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
 *   name: '@mwashburn160/pipeline-manager',
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
                    outDir: 'dist',

                    // Module configuration (CommonJS for CLI compatibility)
                    module: 'CommonJS',
                    target: 'ES2024',
                    lib: ['ES2024'],

                    // Additional strict checks
                    noUncheckedIndexedAccess: true,

                    // Additional options
                    declarationMap: true,
                    allowJs: true,
                    forceConsistentCasingInFileNames: true,
                    types: ['node', 'jest'],
                },

                include: ['src/*'],
                exclude: ['dist', 'node_modules'],
            }
        })
    }

    /**
     * Runs before synthesis to ensure output directory exists.
     */
    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

}
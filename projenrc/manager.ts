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
                    // Source and output directories
                    rootDir: 'src',
                    outDir: 'dist',  // Use 'dist' for CLI apps

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
                    noUncheckedIndexedAccess: true,

                    // Module configuration (CommonJS for CLI compatibility)
                    module: 'CommonJS',
                    target: 'ES2024',
                    lib: ['ES2024'],

                    // Type declarations and source maps
                    declaration: true,
                    declarationMap: true,
                    inlineSourceMap: true,
                    inlineSources: true,

                    // Additional options
                    esModuleInterop: true,
                    resolveJsonModule: true,
                    experimentalDecorators: true,
                    allowJs: true,
                    forceConsistentCasingInFileNames: true,
                    skipLibCheck: true,

                    // Node.js types
                    types: ['node']
                },

                // Include only source files
                include: [
                    'src/*'
                ],

                // Exclude output, dependencies, and tests
                exclude: [
                    'dist',
                    'node_modules',
                    '**/*.spec.ts',
                    '**/*.test.ts'
                ]
            }
        })
    }

    /**
     * Runs before synthesis to ensure output directory exists.
     */
    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

    /**
     * Runs after synthesis to clean up test directories.
     */
    postSynthesize(): void {
        execSync(`if [ -d ${this.outdir}/test ];then rm -rf ${this.outdir}/test;fi`)
    }
}
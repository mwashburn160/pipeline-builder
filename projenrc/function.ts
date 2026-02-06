/**
 * API Service (Function) Project Configuration
 *
 * This module defines the configuration for microservice API applications.
 * These are Express-based services deployed as containerized applications.
 *
 * API Service Characteristics:
 * - ES Module format (NodeNext) for modern Node.js
 * - Express.js web framework
 * - RESTful API endpoints
 * - JWT authentication
 * - PostgreSQL or MongoDB database access
 * - Dockerized deployment
 * - Located in ./api directory
 *
 * Examples of API services:
 * - quota: Resource quota management
 * - plugin: Plugin upload and management
 * - pipeline: Pipeline configuration and metadata
 *
 * Each service follows a standard structure:
 * - src/index.ts: Express app setup and server start
 * - src/routes/: API endpoint handlers
 * - src/middleware/: Custom middleware (auth, quota checks)
 * - src/helpers/: Utility functions
 * - Dockerfile: Container image definition
 *
 * @see TypeScriptAppProject from projen for application projects
 */

import { execSync } from 'node:child_process';
import { TypeScriptModuleResolution } from 'projen/lib/javascript';
import { TypeScriptAppProject, TypeScriptProjectOptions } from 'projen/lib/typescript';

/**
 * API service application project.
 *
 * Extends TypeScriptAppProject with ES module configuration
 * suitable for Express.js microservices.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * let quota = new FunctionProject({
 *   parent: root,
 *   name: 'quota',
 *   deps: ['express', 'cors', 'helmet'],
 * });
 * // Creates project at ./api/quota
 * ```
 */
export class FunctionProject extends TypeScriptAppProject {
    /** Base directory for all API services */
    private _home: string = 'api'

    /**
     * Creates a new API service project.
     *
     * The project is automatically placed in the `api/{name}` directory.
     *
     * @param options - TypeScript project options (name is required)
     */
    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            // Place all API services in the api/ directory
            outdir: `api/${options.name}`,

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

                    // Module configuration (ES Modules)
                    module: 'NodeNext',
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
                    target: 'ESNext',
                    lib: ['ESNext'],

                    // Type declarations and source maps
                    declaration: true,
                    inlineSourceMap: true,
                    inlineSources: true,

                    // Additional options
                    esModuleInterop: true,
                    resolveJsonModule: true,
                    experimentalDecorators: true,
                    stripInternal: true,
                    skipLibCheck: true,

                    // Continue build despite errors (for iterative development)
                    noEmitOnError: false
                }
            }
        })
    }

    /**
     * Runs before synthesis to ensure the api/ directory exists.
     */
    preSynthesize(): void {
        execSync(`if [ ! -d ${this._home} ];then mkdir -p ${this._home};fi`)
    }

    /**
     * Runs after synthesis to clean up test directories.
     */
    postSynthesize(): void {
        execSync(`if [ -d ${this._home}/${this.name}/test ];then rm -rf ${this._home}/${this.name}/test;fi`)
    }
}
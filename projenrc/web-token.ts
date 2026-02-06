/**
 * Web Token Service Project Configuration
 *
 * This module defines the configuration for web services that handle
 * authentication and token management.
 *
 * Web Token Service Characteristics:
 * - ES Module format (NodeNext) for modern Node.js
 * - Express.js web framework
 * - JWT token generation and validation
 * - User authentication endpoints
 * - MongoDB for user/organization data
 * - PostgreSQL for relational data
 * - Email verification and password reset flows
 * - Simplified TypeScript configuration (minimal compiler options)
 *
 * This is used by the platform service which provides:
 * - User registration and login
 * - Organization management
 * - JWT token issuance for other services
 * - Email verification
 * - Password reset
 *
 * Difference from FunctionProject:
 * - Simpler tsconfig (fewer strict checks)
 * - Focused on authentication/authorization workflows
 * - Handles sensitive user data (passwords, tokens)
 *
 * @see TypeScriptAppProject from projen for application projects
 */

import { execSync } from "node:child_process";
import { TypeScriptModuleResolution } from "projen/lib/javascript";
import { TypeScriptAppProject, TypeScriptProjectOptions } from "projen/lib/typescript";

/**
 * Web token service application project.
 *
 * Extends TypeScriptAppProject with a simplified configuration
 * for authentication-focused web services.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * let platform = new WebTokenProject({
 *   parent: root,
 *   name: 'platform',
 *   outdir: './platform',
 *   deps: ['express', 'jsonwebtoken', 'bcryptjs', 'mongoose'],
 * });
 * ```
 */
export class WebTokenProject extends TypeScriptAppProject {

    /**
     * Creates a new web token service project.
     *
     * @param options - TypeScript project options
     */
    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            tsconfig: {
                compilerOptions: {
                    // Target modern Node.js
                    lib: ['ESNext'],
                    target: 'ESNext',

                    // ES Module configuration
                    module: 'NodeNext',
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,

                    // Source and output directories
                    outDir: 'lib',
                    rootDir: 'src',

                    // Basic strict type checking
                    strict: true,

                    // Compatibility and optimization
                    esModuleInterop: true,
                    skipLibCheck: true,
                }
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
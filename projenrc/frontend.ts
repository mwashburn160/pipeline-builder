/**
 * Frontend Application Project Configuration
 *
 * This module defines the configuration for Next.js-based frontend applications.
 *
 * Next.js Project Characteristics:
 * - Server-side rendering (SSR) and static site generation (SSG)
 * - React 18+ for UI components
 * - File-based routing in app/ or pages/ directory
 * - API routes for backend functionality
 * - Built-in TypeScript support
 * - Custom Tailwind configuration (disabled by default, configured manually)
 *
 * The frontend application provides:
 * - User authentication and registration UI
 * - Pipeline management interface
 * - Plugin configuration and upload
 * - Real-time pipeline status updates
 * - Organization and team management
 *
 * @see NextJsProject from projen for Next.js configuration
 * @see https://nextjs.org/docs
 */

import { execSync } from 'node:child_process';
import { NextJsProject, NextJsProjectOptions } from 'projen/lib/web';

/**
 * Next.js frontend application project.
 *
 * Extends NextJsProject with custom configuration for the
 * pipeline builder web interface.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * let frontend = new FrontEndProject({
 *   parent: root,
 *   name: 'frontend',
 *   outdir: './frontend',
 *   deps: ['next', 'react', 'react-dom'],
 * });
 * ```
 */
export class FrontEndProject extends NextJsProject {

    /**
     * Creates a new Next.js frontend project.
     *
     * @param options - Next.js project options
     */
    constructor(options: NextJsProjectOptions) {
        super({
            ...options,
            // Disable projen's default Tailwind setup (we configure it manually)
            tailwind: false
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
     * Next.js test configuration is handled separately.
     */
    postSynthesize(): void {}
}
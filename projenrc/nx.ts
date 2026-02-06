/**
 * Nx Build Orchestration Configuration
 *
 * This module configures Nx for intelligent build orchestration in the monorepo.
 *
 * Nx provides:
 * - **Dependency Graph**: Understands relationships between packages
 * - **Incremental Builds**: Only rebuilds what changed
 * - **Computation Caching**: Caches build outputs locally and remotely
 * - **Parallel Execution**: Runs independent tasks concurrently
 * - **Affected Detection**: Builds only packages affected by changes
 *
 * Build Process:
 * 1. Nx analyzes the dependency graph
 * 2. Determines which projects are affected by changes
 * 3. Builds dependencies first (^build pattern)
 * 4. Runs builds in parallel when possible
 * 5. Caches outputs for future builds
 *
 * @see https://nx.dev/getting-started/intro
 * @see https://nx.dev/concepts/mental-model
 */

import { Component, JsonFile } from 'projen';
import { TypeScriptProject } from 'projen/lib/typescript';

/**
 * Nx build orchestration component.
 *
 * Configures Nx with caching, dependency tracking, and release management
 * for efficient monorepo builds.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * new Nx(root);
 * ```
 */
export class Nx extends Component {
    /**
     * Creates Nx configuration for the monorepo.
     *
     * @param root - The root TypeScript project
     */
    constructor(root: TypeScriptProject) {
        super(root);

        // Add Nx dependencies to the root project
        root.addDevDeps('nx@^22', '@nx/devkit@^22', '@nx/workspace@^22', '@nx/js@^22');

        // Generate nx.json with build orchestration configuration
        new JsonFile(root, 'nx.json', {
            obj: {
                // Use npm workspace preset as base configuration
                extends: 'nx/presets/npm.json',

                // Task runner configuration
                tasksRunnerOptions: {
                    default: {
                        runner: 'nx/tasks-runners/default',
                        options: {
                            // Cache build operations for faster rebuilds
                            cacheableOperations: ['build']
                        },
                        // Skip Nx cache (using custom caching strategy)
                        skipNxCache: true
                    },
                },

                // Default configuration for build targets
                targetDefaults: {
                    build: {
                        // Build dependencies first (^ prefix means upstream deps)
                        dependsOn: ['^build'],

                        // Exclude output directories from build inputs
                        // This prevents cache invalidation from build outputs
                        inputs: [
                            '!{projectRoot}/lib/**/*',
                            '!{projectRoot}/dist/**/*'
                        ],

                        // Define output directories for caching
                        outputs: [
                            '{projectRoot}/lib',
                            '{projectRoot}/dist'
                        ],

                        // Enable caching for build operations
                        cache: true
                    }
                },

                // Release management configuration
                release: {
                    // Apply to all projects in the workspace
                    projects: ['*'],

                    // Independent versioning (each package has own version)
                    projectsRelationship: 'independent',

                    // Git tag format for releases
                    releaseTagPattern: 'release/{projectName}/{version}',

                    // Generate separate changelogs per project
                    changelog: {
                        projectChangelogs: true
                    },

                    // Git commit configuration
                    git: {
                        commitMessage: 'chore: updated version'
                    },

                    // Semantic versioning configuration
                    version: {
                        // Use conventional commits for version bumps
                        conventionalCommits: 'true',

                        versionActionsOptions: {
                            // Don't update lockfile during versioning
                            skipLockFileUpdate: true
                        }
                    }
                },

                // Affected command configuration
                // Compares against origin/main to find changed projects
                affected: { defaultBase: 'origin/main' }
            },
        });
    }
}
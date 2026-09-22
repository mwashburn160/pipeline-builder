// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
        root.addDevDeps('nx@^23', '@nx/devkit@^23', '@nx/workspace@^23', '@nx/js@^23');

        // Generate nx.json with build orchestration configuration
        new JsonFile(root, 'nx.json', {
            obj: {
                // Use npm workspace preset as base configuration
                extends: 'nx/presets/npm.json',

                // Named inputs — what a task's cache key and `nx affected` see.
                //   sharedGlobals: files OUTSIDE any project that change how every
                //     project builds/tests (the jest guards at the root, and the
                //     projen sources that generate every task, tsconfig and dep).
                //     Without them a .projenrc.ts or jest-env-guard.js change left
                //     every project "unaffected" and every cached result valid.
                //   default: the project's own files + sharedGlobals.
                // Projects whose tests read deploy/ or docs/ add those via their
                // package.json `nx` field (REPO_FIXTURE_INPUTS in .projenrc.ts).
                namedInputs: {
                    sharedGlobals: [
                        '{workspaceRoot}/jest-*.js',
                        '{workspaceRoot}/.projenrc.ts',
                        '{workspaceRoot}/projenrc/**/*',
                    ],
                    default: ['{projectRoot}/**/*', 'sharedGlobals'],
                },

                // Up to 3 tasks at once — for the targets that are safe to overlap
                // (compile, eslint). `build`, `test` and the docker targets opt OUT
                // below (`parallelism: false`): their suites share the Redis DB,
                // the docker daemon and per-tier buildkitd, and serializing them is
                // what keeps those runs reliable.
                parallel: 3,

                // Default configuration per target. Split so CI and developers can
                // run the stages separately (`nx run-many -t compile`, `-t eslint`,
                // `-t test`); `build` remains the full compile+test+lint+package
                // contract that gates merges and releases.
                targetDefaults: {
                    build: {
                        // Build dependencies first (^ prefix means upstream deps)
                        dependsOn: ['^build'],
                        // Own files, upstream files and the shared globals — minus
                        // this project's OUTPUT directories, which would otherwise
                        // invalidate the cache on every run. (It listed ONLY the
                        // two negations before, i.e. an effectively empty input
                        // set: nx then fell back to hashing everything, and a root
                        // config change could not be told from a no-op.)
                        inputs: [
                            'default',
                            '^default',
                            'sharedGlobals',
                            '!{projectRoot}/lib/**/*',
                            '!{projectRoot}/dist/**/*',
                        ],
                        outputs: [
                            '{projectRoot}/lib',
                            '{projectRoot}/dist'
                        ],
                        cache: true,
                        parallelism: false,
                    },

                    // Type-check + emit only. Upstream libs must be EMITTED (not
                    // tested) first, including their post-compile copies.
                    compile: {
                        dependsOn: ['pre-compile', '^post-compile'],
                        inputs: ['default', '^default', '!{projectRoot}/lib/**/*', '!{projectRoot}/dist/**/*'],
                        outputs: ['{projectRoot}/lib', '{projectRoot}/dist'],
                        cache: true,
                    },
                    'post-compile': {
                        dependsOn: ['compile'],
                    },

                    // Lint is read-only (no --fix; see .projenrc.ts) and cacheable.
                    eslint: {
                        inputs: ['default', '!{projectRoot}/lib/**/*', '!{projectRoot}/dist/**/*'],
                        cache: true,
                    },

                    // Tests resolve internal packages (`@pipeline-builder/*`) from
                    // their built `lib/` output, so a project's tests can only see
                    // an upstream package's latest exports after that upstream is
                    // rebuilt. `dependsOn: ['^build']` makes `nx affected --target
                    // test` build upstream libs FIRST — this is what removes the
                    // "does not provide an export named X" / stale-lib friction
                    // that let source/test drift (e.g. the accessModifier→visibility
                    // rename) reach main. Not cached: test side-effects/coverage make
                    // caching unsafe.
                    test: {
                        dependsOn: ['^build'],
                        inputs: ['default', '^default', 'sharedGlobals', '!{projectRoot}/lib/**/*', '!{projectRoot}/dist/**/*'],
                        parallelism: false,
                    },
                    'docker:build': { parallelism: false },
                    'docker:publish': { parallelism: false },
                },

                // Release management configuration
                release: {
                    // Apply to all projects in the workspace
                    projects: ['*'],

                    // Independent versioning (each package has own version)
                    projectsRelationship: 'independent',

                    // Git tag format for releases. Nx 23 removed the top-level
                    // `releaseTagPattern` — it now lives under the nested `releaseTag`
                    // object (moved in Nx 22, removed in Nx 23).
                    releaseTag: { pattern: 'release/{projectName}/{version}' },

                    // Changelog generation disabled
                    changelog: false,

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
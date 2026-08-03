// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PNPM Workspace Configuration
 *
 * This module generates the `pnpm-workspace.yaml` file that defines
 * which directories are part of the PNPM workspace.
 *
 * PNPM workspaces enable:
 * - Shared dependency management across packages
 * - Workspace protocol for linking internal packages (workspace:*)
 * - Centralized lockfile for consistent installs
 * - Efficient disk space usage with content-addressable storage
 *
 * @see https://pnpm.io/workspaces
 */

import path from 'path';
import { Component, Project, YamlFile } from 'projen';

/**
 * PNPM workspace component that automatically generates workspace configuration.
 *
 * This component discovers all subprojects in the monorepo and adds them
 * to the pnpm-workspace.yaml file. It runs automatically during synthesis.
 *
 * @example
 * ```typescript
 * // In .projenrc.ts
 * new PnpmWorkspace(root);
 * ```
 */
export class PnpmWorkspace extends Component {
  /**
   * Creates a PNPM workspace configuration.
   *
   * @param root - The root project that contains all subprojects
   */
  constructor(root: Project) {
    super(root);

    // Generate pnpm-workspace.yaml with all subproject paths
    new YamlFile(root, 'pnpm-workspace.yaml', {
      obj: {
        // Map each subproject to its relative path from the root
        packages: root.subprojects.map(
          project => path.relative(
            root.outdir, project.outdir
          )
        ),
        // pnpm 11 blocks dependency build/postinstall scripts unless each is
        // explicitly approved here (else `ERR_PNPM_IGNORED_BUILDS` fails install).
        // These have legitimate native/codegen build steps the toolchain relies on.
        allowBuilds: {
          '@scarf/scarf': true,
          '@swc/core': true,
          esbuild: true,
          'mongodb-memory-server': true,
          'msgpackr-extract': true,
          nx: true,
          protobufjs: true,
          sharp: true,
          'unrs-resolver': true,
        },
        // pnpm 11 otherwise auto-installs before every `pnpm run/exec/nx`. In CI that
        // pre-run install reconciles node_modules in prod mode — pruning devDeps (incl.
        // `nx`) → `Command "nx" not found` in the docker:verify job. Deps are installed
        // explicitly in the bootstrap step, so this pre-run check is redundant + harmful.
        // (This is a pnpm-workspace.yaml setting — `.npmrc` is ignored for it in pnpm 11.)
        verifyDepsBeforeRun: false,
      },
    });
  }
}
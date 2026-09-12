// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PNPM Workspace Configuration
 *
 * This module supplies the contents of the `pnpm-workspace.yaml` file that
 * defines which directories are part of the PNPM workspace.
 *
 * PNPM workspaces enable:
 * - Shared dependency management across packages
 * - Workspace protocol for linking internal packages (workspace:*)
 * - Centralized lockfile for consistent installs
 * - Efficient disk space usage with content-addressable storage
 *
 * projen owns the FILE: `NodePackage` gives every pnpm project a
 * `PnpmWorkspaceYaml` component (carrying its `onlyBuiltDependencies`
 * allowlist), so creating a second file at that path throws "There is already a
 * file under pnpm-workspace.yaml". These settings are therefore passed INTO
 * projen's component via the root project's `pnpmOptions.workspaceYamlOptions`.
 * That is the only seam that works: `file.addOverride` is silently dropped for
 * an otherwise-empty `omitEmpty` file (ObjectFile.synthesizeContent merges
 * overrides only into an already non-empty object) and the file is then deleted.
 *
 * @see https://pnpm.io/workspaces
 */

import path from 'path';
import { Project } from 'projen';
import type { PnpmWorkspaceYamlOptions } from 'projen/lib/javascript';

/**
 * Workspace package paths. Filled by {@link setWorkspacePackages} once the
 * subprojects exist — the SAME array instance is handed to projen below, and
 * its contents are read at synthesis time, so the later write is picked up.
 */
const workspacePackages: string[] = [];

/**
 * `pnpm-workspace.yaml` contents for the root project's `pnpmOptions`.
 *
 * Cast because the pnpm 11 keys (`allowBuilds`, `verifyDepsBeforeRun`,
 * `minimumReleaseAge*`) are absent from projen's typed schema; projen writes
 * them through verbatim.
 */
export const pnpmWorkspaceYamlOptions = {
  // Each subproject's path relative to the root (see setWorkspacePackages).
  packages: workspacePackages,
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
  // Supply-chain quarantine: refuse to install a registry package version
  // younger than 1440 min (24h). Most compromised-release / typosquat
  // incidents are caught and yanked within hours, so a one-day cooling-off
  // window keeps a poisoned just-published version out of the lockfile
  // without a human ever having to notice. Only affects resolution of NEW
  // versions (a frozen lockfile's pinned versions are unaffected).
  minimumReleaseAge: 1440,
  // EXCLUDE our own packages: `pipeline-manager` hard-deps `ai-core` and
  // `setup-events` runs `npm install @pipeline-builder/pipeline-events` at
  // runtime, both pinned to the version the release just published — a 24h
  // age gate would make a fresh release un-installable for a day. Our own
  // registry publishes are trusted, so carve them out.
  minimumReleaseAgeExclude: ['@pipeline-builder/*'],
} as PnpmWorkspaceYamlOptions;

/**
 * Record every subproject path in the workspace. Call AFTER the subprojects are
 * constructed — they are discovered from `root.subprojects`.
 *
 * @param root - The root project that contains all subprojects
 */
export function setWorkspacePackages(root: Project): void {
  workspacePackages.length = 0;
  workspacePackages.push(
    ...root.subprojects.map(project => path.relative(root.outdir, project.outdir)),
  );
}

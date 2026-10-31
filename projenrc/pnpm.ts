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
 * Cast because the newer pnpm workspace keys (`allowBuilds`,
 * `verifyDepsBeforeRun`, `minimumReleaseAge*`) are absent from projen's typed
 * schema; projen writes them through verbatim. The pnpm version itself is
 * pinned by the root package.json `packageManager` field.
 */
export const pnpmWorkspaceYamlOptions = {
  // Each subproject's path relative to the root (see setWorkspacePackages).
  packages: workspacePackages,
  // pnpm blocks dependency build/postinstall scripts unless each is explicitly
  // approved here (else `ERR_PNPM_IGNORED_BUILDS` fails install).
  // These have legitimate native/codegen build steps the toolchain relies on.
  allowBuilds: {
    // jest's optional native file watcher, via jest-haste-map — dev-only, and
    // reached by every project's test run. Surfaced by the pnpm 10 -> 12 bump:
    // nothing about the dependency changed, pnpm simply stopped tolerating an
    // unapproved build script that had been silently skipped.
    '@parcel/watcher': true,
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
  // Explicitly off: when on, pnpm installs before every `pnpm run/exec/nx`, and
  // in CI that pre-run install reconciles node_modules in prod mode — pruning
  // devDeps (incl. `nx`) → `Command "nx" not found` in the docker:verify job.
  // Deps are installed explicitly in the bootstrap step. (A pnpm-workspace.yaml
  // setting; `.npmrc` is not consulted for it.)
  verifyDepsBeforeRun: false,
  // Supply-chain quarantine: REMOVED (was `minimumReleaseAge: 1440`).
  //
  // It refused any registry version younger than 24h, on the reasoning that
  // most compromised-release and typosquat incidents are caught and yanked
  // within hours, so a cooling-off window kept a poisoned just-published
  // version out of the lockfile without anyone having to notice it.
  //
  // Removed by request so an upgrade can take a release the day it ships. The
  // trade is explicit: a package published minutes ago is now installable, and
  // that is precisely the window the policy covered. The exclusion list went
  // with it — it existed only to let specific scopes opt OUT of a rule that no
  // longer applies to anyone.
  //
  // pnpm 12 validated the whole LOCKFILE against this, not just resolution, so
  // this also means a `--frozen-lockfile` install no longer fails on a pinned
  // version that is merely "too new".
  //
  // IT MUST BE 0, NOT ABSENT. Deleting the key does not disable the policy —
  // pnpm 12 applies a 24h window by DEFAULT, so an absent setting still fails
  // the install with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION and a cutoff
  // exactly one day back. Verified: removing the line entirely left 37 lockfile
  // entries rejected. 0 is the only way to turn it off.
  minimumReleaseAge: 0,
  // Force a transitive dep onto a fixed release. SCOPED BY MAJOR (`name@5`),
  // never bare: brace-expansion ships four parallel lines — 1.1.21, 2.1.7,
  // 3.0.9 and 5.0.12 — and a bare override would drag 1.x and 2.x dependents
  // onto a major they were never written against.
  //
  // brace-expansion@5: the release grype gate reported 5.0.9 for
  // GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7 (High) plus
  // GHSA-q2hr-2g5m-vwhr (Medium). The lockfile already resolved 5.0.12 for
  // some dependents and 5.0.9 for others, so this collapses the 5.x line onto
  // the one fixed release rather than introducing a new version to the tree.
  //
  // The rest clear `pnpm audit --prod --audit-level high` (security-audit.yml),
  // which had been red since mid-October. Each is a transitive pin, scoped by
  // major, onto the first fixed release:
  // - follow-redirects@1 → 1.16.2 (axios ^1.16.0): GHSA cross-origin credential
  //   stripping bypass + sensitiveHeaders regex escaping (High).
  // - body-parser@2 → 2.4.0 (express ^2.3.0): DoS via trailing bytes (High).
  // - undici@7 → 7.30.1 (@ai-sdk/provider-utils ^7.29.0): DoS, cache poisoning,
  //   TLS validation bypass (High).
  // - systeminformation@5 → 5.33.19 (OTel host-metrics ^5.31.6): Windows command
  //   injection in services() (High; we never run on Windows, but it is in the tree).
  // - zod@3 → 4.6.7: GHSA-mrhx-c7xc-m3w5 (High) — memory exhaustion validating
  //   oversized collections — has NO fixed 3.x; the patch is >=4.6.6 only. The
  //   sole zod@3 dependent is jimp (via @jimp/types, ^3.23.8, still so at jimp
  //   1.6.1, the latest). This IS a major jump under jimp, so it was verified by
  //   running message's real thumbnail path (Jimp.read → scaleToFit → getBuffer)
  //   against it. Drop this override once jimp moves to zod 4.
  // - zod@4 → 4.6.7: same advisory; other dependents resolved the 4.x line to 4.6.5.
  overrides: {
    'brace-expansion@5': '5.0.12',
    'follow-redirects@1': '1.16.2',
    'body-parser@2': '2.4.0',
    'undici@7': '7.30.1',
    'systeminformation@5': '5.33.19',
    'zod@3': '4.6.7',
    'zod@4': '4.6.7',
  },
  // EXCLUDE our own packages: `pipeline-manager` hard-deps `ai-core` and
  // `setup-events` runs `npm install @pipeline-builder/pipeline-events` at
  // runtime, both pinned to the version the release just published — a 24h
  // age gate would make a fresh release un-installable for a day. Our own
  // registry publishes are trusted, so carve them out.
  // Scopes allowed to land same-day releases, because the toolchain is kept at
  // latest and these four publish most days — without them the lockfile cannot
  // hold a current version at all (see the note above).
  //
  // This is a REAL reduction in cover: these scopes get no cooling-off window,
  // and a compromised publish in one of them would be installable immediately.
  // They are first-party-vendor scopes (AWS, OpenTelemetry, Vercel's AI SDK)
  // rather than long-tail packages, which is the only reason it is tolerable.
  // Narrow this the moment a scope stops needing to be at the bleeding edge.
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

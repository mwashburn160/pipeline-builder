// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap the platform repo (sparse, partial clone).
 *
 * `provision` normally runs from a checkout of this repo, because the deploy
 * scripts live under `deploy/`. To provision a fresh machine in one command, the
 * operator passes `--repo`: provision git-clones the platform repo first, then
 * runs every subsequent step (deploy, init-platform, post-steps) from the clone.
 *
 * A full clone is wasteful — the repo carries `packages/`, `api/`, `platform/`,
 * `frontend/`, … none of which the deploy stack needs. So the clone is a
 * **partial** (`--filter=blob:none`) + **cone sparse-checkout** that materializes
 * only the deploy folders the selected target + options actually use. Pure
 * command assembly here — no git is run; the caller executes the command via the
 * same gated `runScript()` as the deploy.
 */

import { shellQuote } from '../config/cli.constants.js';

/** Canonical upstream platform repo, used when `--repo` is given without a value. */
export const DEFAULT_REPO = 'https://github.com/mwashburn160/pipeline-builder.git';
/** Default ref to check out when bootstrapping (a branch or tag — see below). */
export const DEFAULT_REF = 'main';
/** Default directory to clone into / run from. */
export const DEFAULT_WORKDIR = 'pipeline-builder';

export interface BootstrapSpec {
  /** Git URL to clone. */
  readonly repo: string;
  /** Branch or tag to check out. (Arbitrary SHAs may not fetch under --depth 1.) */
  readonly ref: string;
  /** Directory to clone into / run from (relative to the launch cwd). */
  readonly workdir: string;
  /** Deploy folders to materialize (cone sparse-checkout paths). */
  readonly paths: readonly string[];
  /** When true, skip the partial/sparse flags and do a plain full clone (git < 2.27). */
  readonly full?: boolean;
}

/** Fill partial bootstrap inputs with defaults; `paths` is supplied by the caller. */
export function resolveBootstrap(
  opts: { repo?: string; ref?: string; workdir?: string; full?: boolean },
  paths: readonly string[],
): BootstrapSpec {
  const pick = (v: string | undefined, fallback: string): string =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
  return {
    repo: pick(opts.repo, DEFAULT_REPO),
    ref: pick(opts.ref, DEFAULT_REF),
    workdir: pick(opts.workdir, DEFAULT_WORKDIR),
    paths,
    full: opts.full ?? false,
  };
}

/**
 * Assemble the idempotent bootstrap command. Re-runnable, and **additive** across
 * runs: if `<workdir>` is already a checkout it `sparse-checkout add`s the current
 * paths (so folders from previously-provisioned targets/options are retained) and
 * re-syncs to `<ref>`; otherwise it partial-clones, sets the cone, and checks out.
 *
 * - `--filter=blob:none` lazily fetches blobs; `--no-checkout` + cone sparse-checkout
 *   ⇒ only the listed deploy folders land on disk (git ≥ 2.27).
 * - `spec.full` falls back to a plain full clone (older git).
 * - All interpolated values are single-quoted, so a hostile repo/ref/workdir/path
 *   cannot break out of the command.
 */
export function bootstrapCommand(spec: BootstrapSpec): string {
  const repo = shellQuote(spec.repo);
  const ref = shellQuote(spec.ref);
  const originRef = shellQuote(`origin/${spec.ref}`);
  const dir = shellQuote(spec.workdir);
  const paths = spec.paths.map(shellQuote).join(' ');

  // Shared re-sync tail: prefer the remote-tracking ref, fall back to the local ref.
  const reset = `{ git -C ${dir} reset --hard ${originRef} 2>/dev/null || git -C ${dir} reset --hard ${ref}; }`;
  // Shared idempotent frame: re-sync an existing checkout, else fresh-clone.
  const frame = (existing: string, fresh: string): string =>
    [`if [ -d ${dir}/.git ]; then`, `  ${existing}`, 'else', `  ${fresh}`, 'fi'].join('\n');

  if (spec.full) {
    // Full-clone fallback (no partial/sparse) for git < 2.27.
    return frame(
      `git -C ${dir} fetch --all --tags --prune && git -C ${dir} checkout ${ref} && ${reset};`,
      `git clone ${repo} ${dir} && git -C ${dir} checkout ${ref};`,
    );
  }

  return frame(
    // Additive: keep folders from earlier targets/options already in the cone.
    `git -C ${dir} sparse-checkout add ${paths} && git -C ${dir} fetch --filter=blob:none --depth 1 origin ${ref} && git -C ${dir} checkout ${ref} && ${reset};`,
    `git clone --filter=blob:none --no-checkout --depth 1 ${repo} ${dir} && git -C ${dir} sparse-checkout set --cone ${paths} && git -C ${dir} checkout ${ref};`,
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap the platform repo.
 *
 * `provision` normally runs from a checkout of this repo, because the deploy
 * scripts live under `deploy/<target>/`. To provision a fresh machine in a
 * single command, the operator passes `--repo`: provision git-clones the
 * platform repo first, then runs every subsequent step (deploy, init-platform,
 * post-steps) from the clone. Pure command assembly here — no git is run; the
 * caller executes the command via the same gated `runScript()` as the deploy.
 */

/** Canonical upstream platform repo, used when `--repo` is given without a value. */
export const DEFAULT_REPO = 'https://github.com/mwashburn160/pipeline-builder.git';
/** Default ref to check out when bootstrapping. */
export const DEFAULT_REF = 'main';
/** Default directory to clone into / run from. */
export const DEFAULT_WORKDIR = 'pipeline-builder';

export interface BootstrapSpec {
  /** Git URL to clone. */
  readonly repo: string;
  /** Branch, tag, or commit to check out. */
  readonly ref: string;
  /** Directory to clone into / run from (relative to the launch cwd). */
  readonly workdir: string;
}

/** Fill partial bootstrap inputs with defaults. */
export function resolveBootstrap(opts: { repo?: string; ref?: string; workdir?: string }): BootstrapSpec {
  const pick = (v: string | undefined, fallback: string): string =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
  return {
    repo: pick(opts.repo, DEFAULT_REPO),
    ref: pick(opts.ref, DEFAULT_REF),
    workdir: pick(opts.workdir, DEFAULT_WORKDIR),
  };
}

/** Single-quote a value for safe shell interpolation (handles embedded quotes). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Assemble the idempotent clone/checkout command. Re-runnable: if `<workdir>` is
 * already a git checkout it fetches + checks out + hard-resets to `<ref>`
 * (branch → `origin/<ref>`, tag/sha → `<ref>`); otherwise it clones, then checks
 * out the ref. All interpolated values are single-quoted, so a hostile repo/ref/
 * workdir cannot break out of the command.
 */
export function bootstrapCommand(spec: BootstrapSpec): string {
  const repo = shellQuote(spec.repo);
  const ref = shellQuote(spec.ref);
  const originRef = shellQuote(`origin/${spec.ref}`);
  const dir = shellQuote(spec.workdir);
  return [
    `if [ -d ${dir}/.git ]; then`,
    `  git -C ${dir} fetch --all --tags --prune && git -C ${dir} checkout ${ref} && { git -C ${dir} reset --hard ${originRef} 2>/dev/null || git -C ${dir} reset --hard ${ref}; };`,
    `else`,
    `  git clone ${repo} ${dir} && git -C ${dir} checkout ${ref};`,
    `fi`,
  ].join('\n');
}

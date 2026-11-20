// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The overlay layer: `FROM <current image digest>` plus ONE `RUN` that upgrades
 * the named packages in place — for a prebuilt image (no source), or a package
 * the base or a RUN line installed. Everything the base image config carries
 * (labels, entrypoint, cmd, working directory, env) is inherited unchanged; the
 * user is switched to root for the RUN and restored after it, so the published
 * image runs as the same user it did.
 */

export interface OverlayInput {
  /** `<repository>@sha256:…` — the image being fixed (or Stage 1's rebuilt one). */
  baseRef: string;
  /** The base image config's `User` ('' = root / unset). */
  user: string;
  /** One shell fragment per package (patchers/index.ts `overlayCommand`). */
  commands: string[];
}

const SAFE_USER = /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/;

/** The overlay Dockerfile, or null when there is nothing to run / the inputs can't be rendered safely. */
export function overlayDockerfile(input: OverlayInput): string | null {
  if (input.commands.length === 0) return null;
  if (!/^[A-Za-z0-9.:/_-]+@sha256:[0-9a-f]{64}$/.test(input.baseRef)) return null;
  const user = input.user.trim();
  if (user !== '' && !SAFE_USER.test(user)) return null;
  const run = ['set -eu', ...input.commands].join('; ');
  const lines = [
    '# Pipeline Builder remediation overlay: upgrades the named packages in place.',
    `FROM ${input.baseRef}`,
    'USER root',
    // Exec form: the script is ONE argument to sh, never re-parsed by the frontend.
    `RUN ${JSON.stringify(['/bin/sh', '-c', run])}`,
  ];
  if (user !== '' && user !== 'root' && user !== '0' && user !== '0:0') lines.push(`USER ${user}`);
  return `${lines.join('\n')}\n`;
}

/** Whether a Dockerfile is an overlay this module rendered (the diff-scope check for an overlay patch). */
export function isSingleLayerOverlay(dockerfile: string): boolean {
  const instructions = dockerfile.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const runs = instructions.filter((l) => /^RUN\s/i.test(l));
  return /^FROM\s+\S+@sha256:[0-9a-f]{64}$/i.test(instructions[0] ?? '')
    && runs.length === 1
    && instructions.every((l) => /^(FROM|USER|RUN)\s/i.test(l))
    && instructions.filter((l) => /^FROM\s/i.test(l)).length === 1;
}

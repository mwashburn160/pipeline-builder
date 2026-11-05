// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scheduling class and machine size a submitted build runs with (D11/D13).
 *
 * One resolver for both build-queuing routes (the zip upload and the AI-generated
 * deploy), because the gate has to read the same way on both: a tenant who finds
 * `4x` refused on an upload and silently downgraded on a generated deploy has
 * been told two different things about what their tier includes.
 */

import {
  BUILD_TIER_LADDER,
  DEFAULT_TIER,
  buildSizeLabel,
  buildSizesForTier,
  defaultClassForSize,
  tierAllowsBuildSize,
} from '@pipeline-builder/api-core';
import type { BuildClass, BuildSize, QuotaTier } from '@pipeline-builder/api-core';

import { buildPoolConfigured, buildPoolEnvVar } from './docker-build.js';

export interface BuildShape {
  buildClass: BuildClass;
  buildSize: BuildSize;
}

export type BuildShapeOutcome =
  | ({ ok: true } & BuildShape)
  | { ok: false; error: string; reason: 'tier' | 'supply' };

/**
 * Resolve a request's class and size against the org's tier and the deployment's
 * actual supply.
 *
 * REFUSES a size above the tier's ceiling rather than downgrading it, which is
 * the opposite of what a quota does and is deliberate. A size changes how long
 * the build takes and what it costs, so a silent downgrade means the tenant
 * waits longer than they asked with nothing saying why — and a CI job that pins
 * `4x` for a nightly image would keep "succeeding" at `1x` forever. An explicit
 * 403 names the tier that has it.
 *
 * ALSO REFUSES a size with no buildkitd pool behind it, and that one is not a
 * nicety. A size is a bigger (or smaller) DAEMON, because `buildctl` has no
 * per-build CPU option — the CPU a build may use is the pod's limit. Serving an
 * unconfigured size off the shared daemon is wrong in both directions: above
 * `1x` the tenant pays the multiplier for one times the speed, and below it they
 * get full speed at a fraction of the price, which is a blanket discount on every
 * build. Refusing keeps the price and the delivery honest while the pools are
 * stood up.
 *
 * The CLASS takes no gate at all: every tier has both, and `flexible` is the one
 * the platform WANTS used. Gating it would be charging for the cheaper option.
 * Its default comes from the size (`defaultClassForSize`), so `Small` lands in
 * `flexible` without the caller having to know why — a half-speed build holds
 * its slot about twice as long, and on Developer's single standard slot that
 * would block the only urgent-fix slot for double the time.
 */
export function resolveBuildShape(
  tier: QuotaTier,
  requested: { buildClass?: BuildClass; buildSize?: BuildSize },
): BuildShapeOutcome {
  const buildSize = requested.buildSize ?? '1x';
  const buildClass = requested.buildClass ?? defaultClassForSize(buildSize);

  // An unrecognised tier degrades to the DEFAULT tier's gate rather than
  // throwing, which `tierForQueueName` does for the same reason: a tier lookup
  // that came back odd must not turn an upload into a 500. Degrading to the
  // default is also the conservative direction — the smallest allowance, not
  // every size.
  const gated: QuotaTier = BUILD_TIER_LADDER.includes(tier) ? tier : DEFAULT_TIER;

  if (!tierAllowsBuildSize(gated, buildSize)) {
    const allowed = buildSizesForTier(gated).map((s) => `${buildSizeLabel(s)} (${s})`).join(', ');
    return {
      ok: false,
      reason: 'tier',
      error: `buildSize=${buildSize} (${buildSizeLabel(buildSize)}) is not available on the ${gated} tier (available: ${allowed})`,
    };
  }

  if (!buildPoolConfigured(buildSize)) {
    return {
      ok: false,
      reason: 'supply',
      error: `buildSize=${buildSize} (${buildSizeLabel(buildSize)}) is not available on this deployment: `
        + `no build machine of that size is provisioned (${buildPoolEnvVar(buildSize)} is unset). `
        + 'Use the standard size, or ask your operator to provision one.',
    };
  }

  return { ok: true, buildClass, buildSize };
}

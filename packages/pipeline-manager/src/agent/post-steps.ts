// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-deploy steps.
 *
 * After the platform is deployed, health-checked, and init-platform'd, provision
 * can run additional steps: built-in presets (flag-gated, target-aware) and
 * operator-supplied `--post-step` commands. Pure, deterministic assembly here —
 * provision runs each via the same gated `runScript()` as the deploy.
 */

import type { TargetId } from './targets.js';

export interface PostStep {
  /** Stable id for built-ins, or `custom-N` for operator steps. */
  readonly id: string;
  /** Human label shown in the plan. */
  readonly label: string;
  /** The exact command to run. */
  readonly command: string;
}

/** Inputs the built-in presets read. */
export interface PostStepContext {
  readonly target: TargetId;
  /** Base URL of the deployed platform (from deriveHealthUrl), or null if unknown. */
  readonly url: string | null;
  /** AWS region (ec2/fargate), if provided. */
  readonly region?: string;
}

/** Which presets are enabled, plus any raw operator commands (in order). */
export interface PostStepFlags {
  readonly smokeTest?: boolean;
  readonly events?: boolean;
  readonly steps?: readonly string[];
}

interface Builtin {
  readonly id: string;
  readonly label: string;
  readonly enabled: (f: PostStepFlags) => boolean;
  readonly appliesTo: readonly TargetId[];
  /** Assemble the command, or null when it can't be built for this context. */
  readonly command: (ctx: PostStepContext) => string | null;
}

const BUILTINS: readonly Builtin[] = [
  {
    id: 'smoke-test',
    label: 'Smoke test — read-only API reachability check',
    enabled: (f) => f.smokeTest === true,
    appliesTo: ['local', 'minikube', 'ec2', 'fargate'],
    // -k: local/minikube front a self-signed cert; harmless against the real-cert AWS URLs.
    command: (ctx) => (ctx.url ? `curl -fsSk ${ctx.url}/health && echo 'smoke-test: platform reachable'` : null),
  },
  {
    id: 'events',
    label: 'EventBridge ingestion (pipeline-manager setup-events)',
    enabled: (f) => f.events === true,
    appliesTo: ['ec2', 'fargate'],
    // Requires the pipeline-manager CLI on PATH; reads PLATFORM_BASE_URL /
    // PLATFORM_SECRET_NAME from the environment (the command validates them).
    command: (ctx) => `pipeline-manager setup-events${ctx.region ? ` --region ${ctx.region}` : ''}`,
  },
];

/** A preset the operator requested that does not apply to the chosen target. */
export interface SkippedStep {
  readonly id: string;
  readonly reason: string;
}

export interface ResolvedPostSteps {
  /** Ordered steps to run: applicable built-ins first, then operator steps. */
  readonly steps: PostStep[];
  /** Requested presets that were skipped (wrong target / not assemblable). */
  readonly skipped: SkippedStep[];
}

/**
 * Resolve the ordered post-step list: enabled built-ins that apply to the target
 * (in registry order) first, then operator `--post-step` commands in the order
 * given. Requested-but-inapplicable presets are reported in `skipped` so the
 * caller can warn rather than silently drop them.
 */
export function resolvePostSteps(ctx: PostStepContext, flags: PostStepFlags): ResolvedPostSteps {
  const steps: PostStep[] = [];
  const skipped: SkippedStep[] = [];

  for (const b of BUILTINS) {
    if (!b.enabled(flags)) continue;
    if (!b.appliesTo.includes(ctx.target)) {
      skipped.push({ id: b.id, reason: `not applicable to target '${ctx.target}' (only ${b.appliesTo.join(', ')})` });
      continue;
    }
    const command = b.command(ctx);
    if (!command) {
      skipped.push({ id: b.id, reason: 'could not assemble command for this context' });
      continue;
    }
    steps.push({ id: b.id, label: b.label, command });
  }

  (flags.steps ?? []).forEach((command, i) => {
    if (command.trim() !== '') steps.push({ id: `custom-${i + 1}`, label: `Custom step ${i + 1}`, command });
  });

  return { steps, skipped };
}

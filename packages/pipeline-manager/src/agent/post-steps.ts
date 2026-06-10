// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-install steps.
 *
 * After the platform is deployed + health-checked, provision runs an ordered set
 * of post-install steps: **register** (the admin, via `init-platform.sh`, driven
 * non-interactively by env — which also performs any opt-in plugin/compliance/
 * sample loads), then an optional **smoke-test**, **events** (AWS), and any
 * operator **--post-step** commands. Pure, deterministic assembly here — provision
 * runs each via the same gated `runScript()` as the deploy.
 */

import { LOAD_STEPS, type TargetId } from './targets.js';

export interface PostStep {
  /** Stable id (`register` / `smoke-test` / `events`) or `custom-N`. */
  readonly id: string;
  /** Human label shown in the plan. */
  readonly label: string;
  /** The exact command to run. */
  readonly command: string;
  /** Non-secret env applied to the child for this step (e.g. LOAD_* for register). */
  readonly env?: Readonly<Record<string, string>>;
}

/** A requested step that doesn't apply to the chosen target. */
export interface SkippedStep {
  readonly id: string;
  readonly reason: string;
}

export interface ResolvedPostSteps {
  readonly steps: PostStep[];
  readonly skipped: SkippedStep[];
}

export interface PostStepOptions {
  readonly target: TargetId;
  /** Base URL of the deployed platform (from deriveHealthUrl), or null. */
  readonly url: string | null;
  /** AWS region (ec2/fargate), if provided. */
  readonly region?: string;
  /** Load-step ids enabled via `--with-*` (drive init-platform's LOAD_* envs + sparse paths). */
  readonly enabledLoadIds: readonly string[];
  /** `--build-bootstrap`: build the CodeBuild bootstrap image during register. */
  readonly buildBootstrap: boolean;
  /** False when `--no-init` — skips the register step entirely. */
  readonly init: boolean;
  readonly smokeTest: boolean;
  readonly events: boolean;
  /** Raw operator `--post-step` commands, in order. */
  readonly steps: readonly string[];
}

/** Compute the non-interactive env that drives init-platform's prompts. */
function registerEnv(enabledLoadIds: readonly string[], buildBootstrap: boolean): Record<string, string> {
  const env: Record<string, string> = { BUILD_BOOTSTRAP: buildBootstrap ? 'y' : 'n' };
  for (const step of LOAD_STEPS) env[step.env] = enabledLoadIds.includes(step.id) ? 'y' : 'n';
  return env;
}

/**
 * Resolve the ordered post-install step list: register → smoke-test → events →
 * custom. `register` carries the load + BUILD_BOOTSTRAP env so init-platform runs
 * the enabled loads non-interactively. Requested-but-inapplicable steps land in
 * `skipped` so the caller can warn rather than silently drop them.
 */
export function resolvePostSteps(opts: PostStepOptions): ResolvedPostSteps {
  const steps: PostStep[] = [];
  const skipped: SkippedStep[] = [];

  if (opts.init) {
    const enabled = LOAD_STEPS.filter((s) => opts.enabledLoadIds.includes(s.id)).map((s) => s.id);
    const loads = enabled.length > 0 ? ` (+ ${enabled.join(', ')})` : '';
    steps.push({
      id: 'register',
      label: `Register admin${loads}`,
      command: `./deploy/bin/init-platform.sh ${opts.target}`,
      env: registerEnv(opts.enabledLoadIds, opts.buildBootstrap),
    });
  }

  if (opts.smokeTest) {
    if (opts.url) {
      // -k: local/minikube front a self-signed cert; harmless against real-cert AWS URLs.
      steps.push({
        id: 'smoke-test',
        label: 'Smoke test — read-only API check',
        command: `curl -fsSk ${opts.url}/api/version && echo 'smoke-test: API reachable'`,
      });
    } else {
      skipped.push({ id: 'smoke-test', reason: 'no platform URL to probe for this target' });
    }
  }

  if (opts.events) {
    if (opts.target === 'ec2' || opts.target === 'fargate') {
      // Requires the pipeline-manager CLI on PATH; reads PLATFORM_BASE_URL /
      // PLATFORM_SECRET_NAME from the environment (the command validates them).
      steps.push({
        id: 'events',
        label: 'EventBridge ingestion (setup-events)',
        command: `pipeline-manager setup-events${opts.region ? ` --region ${opts.region}` : ''}`,
      });
    } else {
      skipped.push({ id: 'events', reason: `not applicable to target '${opts.target}' (ec2/fargate only)` });
    }
  }

  opts.steps.forEach((command, i) => {
    if (command.trim() !== '') steps.push({ id: `custom-${i + 1}`, label: `Custom step ${i + 1}`, command });
  });

  return { steps, skipped };
}

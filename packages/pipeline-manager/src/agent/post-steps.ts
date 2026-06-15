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
  /** `--auto-init` (ec2): the instance self-runs init-platform on first boot, so the
   *  register step is NOT surfaced here (it would duplicate the on-box run). */
  readonly autoInit?: boolean;
  readonly smokeTest: boolean;
  /** `--with-events`: the AWS event-ingestion bundle (store-token → setup-events). */
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

  // --auto-init (ec2): the instance runs init-platform itself on first boot (register +
  // all loads), so DON'T add a register step here — it would duplicate the on-box run.
  // (The caller prints a positive "auto-init enabled" note instead of a skip warning.)
  const autoInitOnBox = opts.init && opts.autoInit === true && opts.target === 'ec2';
  if (opts.init && !autoInitOnBox) {
    const enabled = LOAD_STEPS.filter((s) => opts.enabledLoadIds.includes(s.id)).map((s) => s.id);
    const loads = enabled.length > 0 ? ` (+ ${enabled.join(', ')})` : '';
    // On AWS (ec2/fargate) register can't run from here — it builds + pushes images and
    // reads the cluster's jwt-secret, so it runs ON the box and is surfaced as a manual
    // next-step. Bake the resolved platform URL into the command so the operator copy-pastes
    // a correct line (and a stale PLATFORM_BASE_URL in their shell can't misdirect it).
    const isAws = opts.target === 'ec2' || opts.target === 'fargate';
    const registerCommand = isAws && opts.url
      ? `PLATFORM_BASE_URL=${opts.url} ./deploy/bin/init-platform.sh ${opts.target}`
      : `./deploy/bin/init-platform.sh ${opts.target}`;
    steps.push({
      id: 'register',
      label: `Register admin${loads}`,
      command: registerCommand,
      env: registerEnv(opts.enabledLoadIds, opts.buildBootstrap),
    });
  }

  if (opts.smokeTest) {
    if (opts.url) {
      // -k: local/minikube front a self-signed cert; harmless against real-cert AWS URLs.
      // Probe /health — the one route guaranteed to exist and serve unauthenticated
      // through nginx (every /api/* route requires auth → 401; /api/version doesn't
      // exist and would fall through to the SPA, making `curl -f` meaningless).
      steps.push({
        id: 'smoke-test',
        label: 'Smoke test — gateway/API reachability',
        command: `curl -fsSk ${opts.url}/health && echo 'smoke-test: API reachable'`,
      });
    } else {
      skipped.push({ id: 'smoke-test', reason: 'no platform URL to probe for this target' });
    }
  }

  if (opts.events) {
    if (opts.target === 'ec2' || opts.target === 'fargate') {
      // Event ingestion needs a platform JWT in Secrets Manager BEFORE the Lambda
      // is wired up, so this is a two-step bundle: store-token writes the token,
      // then setup-events deploys the EventBridge → SQS → Lambda that reads it.
      // store-token derives the secret path from the JWT's org (CoreConstants pattern
      // → pipeline-builder/{orgId}/platform). NOTE: setup-events still REQUIRES that
      // name via --secret-name / PLATFORM_SECRET_NAME (it does not yet derive it), so
      // the operator supplies it when running this bundle. provision surfaces (does not
      // auto-run) the bundle on AWS — it needs a registered, in-VPC platform.
      const region = opts.region ? ` --region ${opts.region}` : '';
      const env = opts.url ? { PLATFORM_BASE_URL: opts.url } : undefined;
      steps.push({
        id: 'store-token',
        label: 'Store platform token in AWS Secrets Manager',
        command: `pipeline-manager store-token${region}`,
        env,
      });
      steps.push({
        id: 'events',
        label: 'EventBridge ingestion (setup-events)',
        command: `pipeline-manager setup-events${region}`,
        env,
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

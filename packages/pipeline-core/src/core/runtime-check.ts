// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Run-time plugin vulnerability check — the CDK-free half.
 *
 * A step's image is pinned at synth. A CVE published (or a KEV listing, or an
 * org-policy change) AFTER that synth never reaches a pipeline that is simply
 * re-run, so a pipeline can opt in to re-asking the plugin service at run
 * time: with {@link RUNTIME_VULN_CHECK_KEY} set, the synth adds one verify
 * step to each stage that runs `pipeline-manager plugin verify --pipeline-id …`,
 * which posts the stage's (stepKey, imageDigest) pairs to
 * `POST /api/plugins/runtime-check` and prints the graded verdict into the
 * build log (the platform also notifies on a pipeline running a vulnerable
 * plugin). It NEVER fails the stage: vulnerability state is reported, not
 * enforced.
 *
 * Dependency-free so the CLI and the synth share one shape.
 */

/**
 * Pipeline metadata flag (boolean, default false). Under `aws:cdk:` so it is
 * never exported into a step's environment like plain metadata keys are.
 */
export const RUNTIME_VULN_CHECK_KEY = 'aws:cdk:operations:runtimevulncheck';

/** Env var carrying the verify step's JSON `RuntimeCheckStep[]`. */
export const RUNTIME_CHECK_STEPS_ENV = 'PB_VERIFY_STEPS';

/** One step the run-time check asks about. `stepKey` is the step label (`pluginStepLabel`). */
export interface RuntimeCheckStep {
  readonly stepKey: string;
  readonly imageDigest: string;
}

/** Graded verdict, least to most serious. Never a refusal. */
export type RuntimeCheckVerdict = 'ok' | 'info' | 'warning' | 'error' | 'critical';

export const RUNTIME_CHECK_VERDICTS: readonly RuntimeCheckVerdict[] = ['ok', 'info', 'warning', 'error', 'critical'];

/** `POST /api/plugins/runtime-check` answer. */
export interface RuntimeCheckResult {
  readonly verdict: RuntimeCheckVerdict;
  readonly steps: ReadonlyArray<{
    readonly stepKey: string;
    readonly imageDigest: string;
    readonly verdict: RuntimeCheckVerdict;
    readonly reasons: ReadonlyArray<{ readonly code: string; readonly message: string; readonly severity?: string }>;
  }>;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Parse a JSON `RuntimeCheckStep[]` (the env var, or a file). Throws on
 * anything malformed: a verify step that silently checked nothing would be a
 * false green.
 */
export function parseRuntimeCheckSteps(json: string): RuntimeCheckStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${RUNTIME_CHECK_STEPS_ENV} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${RUNTIME_CHECK_STEPS_ENV} must be a JSON array of { stepKey, imageDigest }`);
  return parsed.map((entry, i) => {
    const e = entry as Partial<RuntimeCheckStep> | null;
    if (!e || typeof e.stepKey !== 'string' || e.stepKey.length === 0 || typeof e.imageDigest !== 'string' || !DIGEST_RE.test(e.imageDigest)) {
      throw new Error(`${RUNTIME_CHECK_STEPS_ENV}[${i}] must be { stepKey: string, imageDigest: sha256:<64 hex> }`);
    }
    return { stepKey: e.stepKey, imageDigest: e.imageDigest };
  });
}

/** Whether a metadata value turns the check on (`true` / `"true"`). */
export function isRuntimeVulnCheckEnabled(metadata: Record<string, unknown> | undefined): boolean {
  const v = metadata?.[RUNTIME_VULN_CHECK_KEY];
  return v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
}

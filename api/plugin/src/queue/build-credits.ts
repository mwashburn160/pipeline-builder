// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildSizeMultiplier, SYSTEM_ORG_ID, envInt, createLogger, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';
import type { BuildSize, QuotaService } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { Job } from 'bullmq';

import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';

const logger = createLogger('build-credits');

/**
 * vCPU the buildkitd sidecar is assumed to occupy for one build.
 *
 * Read from configuration rather than hardcoded because the whole `cpuCredits`
 * ladder is derived from it (`credits = builds x wall-minutes x vcpu`), and
 * because the supply check needs the same figure to compute what the pool can
 * actually deliver. `deploy/<target>/k8s/plugin.yaml` sets `limits.cpu: 1500m`.
 *
 * Expressed in MILLI-vCPU so it stays an integer env var, matching how
 * Kubernetes spells it.
 */
const BUILDKIT_MILLI_VCPU = envInt('PLUGIN_BUILDKIT_MILLI_VCPU', 1500, { min: 1 });

/** The vCPU figure the ladder is derived from, for callers that report it. */
export const BUILDKIT_VCPU = BUILDKIT_MILLI_VCPU / 1000;

/**
 * Credits for one build, from its wall-clock occupancy.
 *
 * A credit is a vCPU-MINUTE, and a build is billed to the next whole credit.
 * Rounding up per build is deliberate and has precedent: GitHub rounds every
 * job up to the minute. The alternative — a fractional counter — would need the
 * stored unit to be vCPU-SECONDS while every tier limit, pack grant and invariant
 * test is denominated in credits, and a quota whose counter and limit carry
 * different units is a bug waiting for its first off-by-sixty.
 *
 * Returns 0 for a non-positive or unmeasurable duration rather than guessing:
 * a build with no timestamps was not observed, and charging for unobserved work
 * is worse than missing it.
 */
export function creditsForBuild(processedOn?: number, finishedOn?: number, buildSize: BuildSize = '1x'): number {
  // `== null`, not falsiness: a timestamp of 0 is a real instant, and treating
  // it as "unmeasured" would silently stop charging for any build whose clock
  // base happens to be the epoch. The duration check below is what rejects a
  // nonsensical span.
  if (processedOn == null || finishedOn == null) return 0;
  const ms = finishedOn - processedOn;
  if (!(ms > 0)) return 0;
  // The size multiplies the vCPU, because that is what it BUYS: a `2x` build
  // occupies a buildkitd with twice the CPU limit. So the meter stays honest
  // either way the build goes — a build that parallelises finishes in about half
  // the wall time and costs roughly the same (which is the pitch), and one that
  // does not costs twice as much (which is the truth). Charging `1x` for a `2x`
  // machine would make the size a free speed-up and the credit a fiction.
  //
  // This is also why a size is never SUGGESTED without measured per-plugin
  // speedup: a 4x charge on an I/O-bound build that gains nothing is the
  // complaint that sticks.
  return Math.ceil((ms / 60_000) * BUILDKIT_VCPU * buildSizeMultiplier(buildSize));
}

/**
 * Whether this build spends a tier budget at all.
 *
 * Two exemptions, and without them a fresh install spends its own first budget
 * on its own seed data:
 *
 *  - the SYSTEM org, which is where the sample plugin catalogue loads;
 *  - a setup-load build, which is the install-time image bake.
 *
 * Both are platform work done on the tenant's behalf rather than work the tenant
 * asked for, which is the same line `meteredQuotaTypeFor` draws for API calls.
 */
export function buildSpendsCredits(data: Pick<PluginBuildJobData, 'orgId' | 'setupLoad'>): boolean {
  if (data.orgId === SYSTEM_ORG_ID) return false;
  if (data.setupLoad) return false;
  return true;
}

/**
 * Whether a FAILED build is charged.
 *
 * Charge what the tenant caused, not what the platform did. A `permanent`
 * failure is tenant content — a broken Dockerfile, a refused scan gate — and it
 * occupied the pool exactly as a success would, so it is charged (D4). A
 * `retryable` one is the platform's (a Redis blip, a registry timeout), and
 * charging it would bill a tenant for our own retry.
 *
 * The distinction matters because BullMQ sets `processedOn`/`finishedOn` on EVERY
 * attempt, so without this condition a job retried to exhaustion charges once per
 * attempt — and `PLUGIN_BUILD_MAX_ATTEMPTS` defaults to 2.
 */
export function failedBuildIsCharged(category: string | undefined): boolean {
  return category === 'permanent';
}

/** `user` for a person in a browser session, `automation` for a key-driven build. */
export function buildTrigger(data: Pick<PluginBuildJobData, 'publish'>): 'user' | 'automation' {
  const pt = data.publish?.caller?.principalType;
  return pt === 'service_account' || pt === 'api_key' ? 'automation' : 'user';
}

/**
 * Charge a finished build's credits — BEST-EFFORT, like every other increment.
 *
 * Never throws and never blocks: a build that has already run cannot be un-run
 * by an accounting failure, and the admission check at submission is what bounds
 * the budget. A dropped charge under-counts, which the
 * `cpu_credits_charged_total` counter makes visible against the duration
 * histogram beside it — if the two disagree, the accounting is wrong.
 */
export async function chargeBuildCredits(
  quotaService: QuotaService,
  job: Job<PluginBuildJobData>,
  outcome: 'success' | 'failed',
): Promise<void> {
  const orgId = job.data?.orgId;
  if (!orgId || !buildSpendsCredits(job.data)) return;
  if (outcome === 'failed' && !failedBuildIsCharged(job.data.failureCategory)) return;

  const buildSize = job.data.buildSize ?? '1x';
  const buildClass = job.data.buildClass ?? 'standard';
  const credits = creditsForBuild(job.processedOn, job.finishedOn, buildSize);
  if (credits <= 0) return;

  incCounter('cpu_credits_charged_total', { org_id: orgId, outcome, build_class: buildClass, build_size: buildSize });
  try {
    // `incrementMetered` rather than `incrementQuota`: the latter adds ONE unit
    // per call (it is built for per-request metering), and a build charges many.
    // The group's `amount` is what carries them, and the attribution rides with
    // it — route, principal, plugin and class — so "why is our build budget
    // gone?" is answerable from the ledger rather than from the logs.
    await quotaService.incrementMetered(orgId, 'cpuCredits', getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }), [{
      amount: credits,
      attribution: {
        route: 'BUILD plugin',
        principalType: job.data.publish?.caller?.principalType as never,
        principalId: job.data.userId,
        // class and size ride in the feature so the ledger answers "what did we
        // spend this on" without a second lookup — a tenant surprised by their
        // burn is usually surprised by a `4x` or by automation, and both are
        // here.
        feature: `build:${buildTrigger(job.data)}:${buildClass}:${buildSize}`,
      },
    }]);
  } catch (err) {
    logger.warn('CPU credit charge failed; build budget under-counted', {
      orgId, jobId: job.id, credits, outcome, error: errorMessage(err),
    });
  }
}

/**
 * Admission: is this org already out of CPU credits?
 *
 * Checked BEFORE enqueue, alongside the existing `plugins` reservation, so an
 * org over budget is told at submission rather than discovering it when a build
 * that looked accepted never produces an image.
 *
 * A CHECK rather than a reservation, and that is a deliberate limit of this
 * step: a build's cost is not known until it has run, so there is nothing
 * precise to reserve. Reserving an ESTIMATE and truing it up (D3) is the
 * refinement that makes concurrent submissions safe against each other; until
 * then two simultaneous builds can both be admitted at the cap and overshoot it
 * by their own cost, which the metered increment records as `overshoot` rather
 * than losing.
 *
 * Fails CLOSED (returns false) when the quota service cannot answer, per D6:
 * admitting a build whose budget could not be confirmed is how an unmetered
 * build pool is discovered later from a bill.
 */
export async function admitBuildOnCredits(
  quotaService: QuotaService,
  orgId: string,
  data: Pick<PluginBuildJobData, 'orgId' | 'setupLoad'>,
): Promise<{ admitted: boolean; used?: number; limit?: number; resetAt?: string }> {
  if (!buildSpendsCredits(data)) return { admitted: true };
  try {
    const result = await quotaService.check(
      orgId, 'cpuCredits', getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }),
    );
    return { admitted: result.allowed, used: result.used, limit: result.limit, resetAt: result.resetAt };
  } catch (err) {
    logger.warn('CPU credit admission check failed; refusing the build (fail closed)', {
      orgId, error: errorMessage(err),
    });
    return { admitted: false };
  }
}

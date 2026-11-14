// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Toolchain RUN DATA (docs/plans/bootstrap-image-versioning.md §6, §7, §9):
 * which managed toolchain release each `synth` / `self-mutation` action ran on,
 * and the two queries built over those rows — the canary gate and the Affected
 * view.
 *
 * WHERE THE RELEASE COMES FROM. pipeline-events is a Lambda in the CUSTOMER's
 * account; everything it posts is customer-controlled, and the tags it reads
 * are cached for 15 minutes. So the release is never read from the payload or
 * a tag: the ingest joins the event to the PLATFORM's deployed step manifest
 * for that pipeline (`pipeline_step_manifests`, written by the registry POST
 * after a deploy) and takes the release from its `build-image` entry — the
 * `pipeline-bootstrap` row, whose version IS the release (both halves share
 * it). The manifest is replaced on every deploy, so it is the release the
 * pipeline was deployed with when the event arrives.
 *
 * THE GATE IS ADVISORY. Outcomes are customer-reported (the events Lambda and
 * its key live in the customer's account), so a canary org could forge them.
 * Each org therefore counts for at most `ceil(N / M)` runs, so one org cannot
 * satisfy the gate alone; the release comes from the platform's manifest; and
 * the gate only informs a human — an override records a reason.
 */

import { BUILD_IMAGE_STEP_KEY, MANAGED_TOOLCHAIN, TOOLCHAIN_RELEASE_VERSION_PATTERN } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { executeRows, type SqlExecutor } from '../../database/pg-result.js';

// -----------------------------------------------------------------------------
// Which actions are toolchain runs
// -----------------------------------------------------------------------------

/** The two toolchain actions a release is judged on. */
export type ToolchainAction = 'synth' | 'self-mutation';

/** Terminal toolchain outcomes; anything else (STARTED, CANCELED, ABANDONED…) says nothing about the toolchain. */
export type ToolchainOutcome = 'succeeded' | 'failed';

/**
 * CDK Pipelines' self-mutation action: a fixed stage and action name
 * (`aws-cdk-lib/pipelines/lib/codepipeline/codepipeline.js`).
 */
export const SELF_MUTATION_STAGE = 'UpdatePipeline';
export const SELF_MUTATION_ACTION = 'SelfMutate';

/**
 * The synth step's `stepKey` in the step manifest (`pluginStepLabel(null, …)`).
 * The synth ACTION's name is a generated id, so it is identified by the
 * manifest row carrying this key — the names the built pipeline really used.
 */
export const SYNTH_STEP_KEY = 'synth';

/**
 * The `build-image` entry's plugin: the release's bootstrap half. The entry is
 * the manifest's non-step row under `step_key` {@link BUILD_IMAGE_STEP_KEY}
 * (api-core `BUILD_IMAGE_MANIFEST_*`), and its `plugin_version` IS the release.
 */
const BUILD_IMAGE_PLUGIN = MANAGED_TOOLCHAIN.bootstrap;

/** A manifest row, as {@link deployedToolchainOf} reads it. */
export interface ToolchainManifestRow {
  pipelineId: string;
  orgId: string;
  stageName: string;
  actionName: string;
  pluginPublisher: string | null;
  pluginName: string | null;
  pluginVersion: string | null;
  stepKey?: string | null;
}

/** One pipeline's deployed toolchain, from its manifest. */
export interface DeployedToolchain {
  orgId: string;
  /** The release its `build-image` entry records. */
  releaseVersion: string;
  /** The synth action as the built pipeline names it; null when the manifest has no synth row. */
  synth: { stageName: string; actionName: string } | null;
}

/**
 * Each pipeline's deployed toolchain, from its manifest rows. A pipeline
 * whose manifest records no `build-image` entry (deployed before releases, or
 * a placeholder bootstrap) has none, and its actions are not stamped. Only an
 * OWN-ORG row (no publisher) counts: a managed name can never be a listing.
 */
export function deployedToolchainOf(rows: readonly ToolchainManifestRow[]): Map<string, DeployedToolchain> {
  const release = new Map<string, { orgId: string; releaseVersion: string }>();
  const synth = new Map<string, { stageName: string; actionName: string }>();
  for (const r of rows) {
    if (r.stepKey === BUILD_IMAGE_STEP_KEY && r.pluginName === BUILD_IMAGE_PLUGIN && r.pluginPublisher === null
      && typeof r.pluginVersion === 'string' && TOOLCHAIN_RELEASE_VERSION_PATTERN.test(r.pluginVersion)) {
      release.set(r.pipelineId, { orgId: r.orgId, releaseVersion: r.pluginVersion });
    }
    if (r.stepKey === SYNTH_STEP_KEY) synth.set(r.pipelineId, { stageName: r.stageName, actionName: r.actionName });
  }
  const out = new Map<string, DeployedToolchain>();
  for (const [pipelineId, r] of release) out.set(pipelineId, { ...r, synth: synth.get(pipelineId) ?? null });
  return out;
}

/**
 * Which toolchain action (if any) an ACTION event is, given its pipeline's
 * deployed toolchain. Names are compared post-scrub, as the manifest stores them.
 */
export function toolchainActionOf(
  event: { eventType: string; stageName?: string | null; actionName?: string | null },
  deployed: DeployedToolchain | undefined,
): ToolchainAction | null {
  if (event.eventType !== 'ACTION' || !deployed || !event.stageName || !event.actionName) return null;
  if (event.stageName === SELF_MUTATION_STAGE && event.actionName === SELF_MUTATION_ACTION) return 'self-mutation';
  if (deployed.synth && event.stageName === deployed.synth.stageName && event.actionName === deployed.synth.actionName) return 'synth';
  return null;
}

/** The terminal outcome of a status, or null for a non-terminal / non-judging one. */
export function toolchainOutcomeOf(status: string): ToolchainOutcome | null {
  if (status === 'SUCCEEDED') return 'succeeded';
  if (status === 'FAILED') return 'failed';
  return null;
}

/** SQL: a stamped row's action (stamped rows are synth or self-mutation only). */
const IS_SELF_MUTATION = sql`(e.stage_name = ${SELF_MUTATION_STAGE} AND e.action_name = ${SELF_MUTATION_ACTION})`;

// -----------------------------------------------------------------------------
// Canary gate (§6) — pure computation
// -----------------------------------------------------------------------------

/** The gate's thresholds (set on the console, Phase 5). */
export interface CanaryGateParams {
  /** N: counted synth runs required. */
  minRuns: number;
  /** M: distinct orgs required. */
  minOrgs: number;
  /** T: the release's failure rate may exceed the default's by at most this many percentage points. */
  maxFailurePointsAboveDefault: number;
}

export const DEFAULT_CANARY_GATE: Readonly<CanaryGateParams> = Object.freeze({
  minRuns: 20,
  minOrgs: 2,
  maxFailurePointsAboveDefault: 5,
});

/** One org's terminal synth outcomes on the candidate, NEWEST first. */
export interface OrgRuns {
  orgId: string;
  outcomes: readonly ToolchainOutcome[];
}

export interface CanaryGateInput {
  releaseVersion: string;
  candidate: readonly OrgRuns[];
  /** The current platform default's synth runs over the same window (uncapped). */
  baseline: { releaseVersion: string | null; runs: number; failures: number };
  params?: Partial<CanaryGateParams>;
}

export type CanaryGateShortfall = 'runs' | 'orgs' | 'failure-rate';

/** The gate's verdict and every number behind it — what the console shows. */
export interface CanaryGateResult {
  passed: boolean;
  releaseVersion: string;
  params: CanaryGateParams;
  /** ceil(N / M): the most runs any one org contributes. */
  perOrgCap: number;
  /** Runs counted toward N, after the per-org cap. */
  countedRuns: number;
  /** Every terminal synth run on the release, before the cap. */
  totalRuns: number;
  /** Distinct orgs with at least one counted run. */
  orgs: number;
  /** Failures among the counted runs. */
  failures: number;
  /** Percent (0–100) over the counted runs; null with none. */
  failureRate: number | null;
  baselineReleaseVersion: string | null;
  baselineRuns: number;
  /** Percent (0–100); 0 when the default has no runs in the window (the strict reading). */
  baselineFailureRate: number;
  /** failureRate − baselineFailureRate, in points; null with no counted runs. */
  pointsAboveDefault: number | null;
  /** Which thresholds were not met (empty when passed). */
  shortfalls: CanaryGateShortfall[];
}

/** Round to 2 dp, so the numbers the console shows are stable. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function resolveParams(p: Partial<CanaryGateParams> | undefined): CanaryGateParams {
  const merged = { ...DEFAULT_CANARY_GATE, ...(p ?? {}) };
  const minRuns = Math.max(1, Math.floor(merged.minRuns));
  const minOrgs = Math.max(1, Math.floor(merged.minOrgs));
  const maxFailurePointsAboveDefault = Math.max(0, merged.maxFailurePointsAboveDefault);
  if (![minRuns, minOrgs, maxFailurePointsAboveDefault].every(Number.isFinite)) return { ...DEFAULT_CANARY_GATE };
  return { minRuns, minOrgs, maxFailurePointsAboveDefault };
}

/** The per-org contribution cap: ceil(N / M). */
export function canaryPerOrgCap(params: Pick<CanaryGateParams, 'minRuns' | 'minOrgs'>): number {
  return Math.ceil(params.minRuns / params.minOrgs);
}

/**
 * The canary gate: at least N counted synth runs across at least M orgs, and a
 * failure rate within T points of the current default's. Each org counts its
 * most recent `ceil(N / M)` runs only — toward N AND toward the failure rate,
 * so one org can neither satisfy N alone nor dominate the rate. Being BETTER
 * than the default never fails the gate.
 */
export function evaluateCanaryGate(input: CanaryGateInput): CanaryGateResult {
  const params = resolveParams(input.params);
  const perOrgCap = canaryPerOrgCap(params);
  let countedRuns = 0;
  let failures = 0;
  let totalRuns = 0;
  let orgs = 0;
  for (const org of input.candidate) {
    totalRuns += org.outcomes.length;
    const counted = org.outcomes.slice(0, perOrgCap);
    if (counted.length === 0) continue;
    orgs++;
    countedRuns += counted.length;
    failures += counted.filter((o) => o === 'failed').length;
  }
  const failureRate = countedRuns > 0 ? r2((failures / countedRuns) * 100) : null;
  const baselineFailureRate = input.baseline.runs > 0 ? r2((input.baseline.failures / input.baseline.runs) * 100) : 0;
  const pointsAboveDefault = failureRate === null ? null : r2(failureRate - baselineFailureRate);

  const shortfalls: CanaryGateShortfall[] = [];
  if (countedRuns < params.minRuns) shortfalls.push('runs');
  if (orgs < params.minOrgs) shortfalls.push('orgs');
  if (pointsAboveDefault === null || pointsAboveDefault > params.maxFailurePointsAboveDefault) shortfalls.push('failure-rate');

  return {
    passed: shortfalls.length === 0,
    releaseVersion: input.releaseVersion,
    params,
    perOrgCap,
    countedRuns,
    totalRuns,
    orgs,
    failures,
    failureRate,
    baselineReleaseVersion: input.baseline.releaseVersion,
    baselineRuns: input.baseline.runs,
    baselineFailureRate,
    pointsAboveDefault,
    shortfalls,
  };
}

// -----------------------------------------------------------------------------
// Canary gate — the read
// -----------------------------------------------------------------------------

/**
 * Evaluate the canary gate for `releaseVersion` against `baselineReleaseVersion`
 * (the current platform default; null when none) from the stamped rows.
 *
 * Window: since the release was registered (`toolchain_release.created_at`),
 * for both the candidate and the default, so the two rates are contemporaneous.
 * Only terminal (SUCCEEDED / FAILED) SYNTH runs count; self-mutation is not
 * part of the gate (§6 counts synth runs).
 *
 * Reads every org's rows: run it ELEVATED (the plugin service's toolchain tx
 * is). The candidate read is bounded at `ceil(N/M)` rows per org.
 */
export async function readCanaryGate(
  db: SqlExecutor,
  releaseVersion: string,
  baselineReleaseVersion: string | null,
  params?: Partial<CanaryGateParams>,
): Promise<CanaryGateResult> {
  const resolved = resolveParams(params);
  const cap = canaryPerOrgCap(resolved);
  const since = sql`(SELECT created_at FROM toolchain_release WHERE release_version = ${releaseVersion})`;
  const candidate = await executeRows<{ org_id: string; status: string; total: string | number }>(db, sql`
    SELECT org_id, status, total FROM (
      SELECT e.org_id, e.status,
             row_number() OVER (PARTITION BY e.org_id ORDER BY coalesce(e.completed_at, e.created_at) DESC, e.id) AS rn,
             count(*) OVER (PARTITION BY e.org_id) AS total
        FROM pipeline_events e
       WHERE e.toolchain_release = ${releaseVersion}
         AND e.event_type = 'ACTION' AND e.status IN ('SUCCEEDED', 'FAILED')
         AND NOT ${IS_SELF_MUTATION}
         AND e.created_at >= coalesce(${since}, '-infinity'::timestamptz)
    ) x
    WHERE rn <= ${cap}
    ORDER BY org_id, rn
  `);
  const byOrg = new Map<string, { outcomes: ToolchainOutcome[]; total: number }>();
  for (const row of candidate) {
    const entry = byOrg.get(row.org_id) ?? { outcomes: [], total: Number(row.total) };
    entry.outcomes.push(row.status === 'FAILED' ? 'failed' : 'succeeded');
    byOrg.set(row.org_id, entry);
  }

  let baseline = { releaseVersion: baselineReleaseVersion, runs: 0, failures: 0 };
  if (baselineReleaseVersion !== null && baselineReleaseVersion !== releaseVersion) {
    const [b] = await executeRows<{ runs: string | number; failures: string | number }>(db, sql`
      SELECT count(*) AS runs, count(*) FILTER (WHERE e.status = 'FAILED') AS failures
        FROM pipeline_events e
       WHERE e.toolchain_release = ${baselineReleaseVersion}
         AND e.event_type = 'ACTION' AND e.status IN ('SUCCEEDED', 'FAILED')
         AND NOT ${IS_SELF_MUTATION}
         AND e.created_at >= coalesce(${since}, '-infinity'::timestamptz)
    `);
    baseline = { releaseVersion: baselineReleaseVersion, runs: Number(b?.runs ?? 0), failures: Number(b?.failures ?? 0) };
  }

  const result = evaluateCanaryGate({
    releaseVersion,
    candidate: [...byOrg.entries()].map(([orgId, e]) => ({ orgId, outcomes: e.outcomes })),
    baseline,
    params: resolved,
  });
  // The read is already capped per org, so the pre-cap total is the window count.
  return { ...result, totalRuns: [...byOrg.values()].reduce((n, e) => n + e.total, 0) };
}

// -----------------------------------------------------------------------------
// Affected view (§9)
// -----------------------------------------------------------------------------

export interface AffectedOrg {
  orgId: string;
  /** Pipelines in this org on the release whose latest synth failed. */
  pipelines: number;
  pipelineIds: string[];
}

export interface AffectedPipelines {
  releaseVersion: string;
  totalPipelines: number;
  orgs: AffectedOrg[];
}

/**
 * Pipelines whose DEPLOYED release is `releaseVersion` (their manifest's
 * `build-image` entry) and whose LATEST terminal synth run failed, grouped by
 * org — the console's Affected view and the "Notify affected owners" target
 * set. A pipeline whose latest synth succeeded has healed and is not listed.
 *
 * Elevated read: it spans every org. Callers show the system-org operator
 * counts, and notify each org about its own pipelines only.
 */
export async function readAffectedPipelines(db: SqlExecutor, releaseVersion: string): Promise<AffectedPipelines> {
  const rows = await executeRows<{ org_id: string; pipeline_id: string }>(db, sql`
    SELECT m.org_id, m.pipeline_id::text AS pipeline_id
      FROM pipeline_step_manifests m
      JOIN LATERAL (
        SELECT e.status
          FROM pipeline_events e
         WHERE e.pipeline_id = m.pipeline_id
           AND e.toolchain_release IS NOT NULL
           AND e.event_type = 'ACTION' AND e.status IN ('SUCCEEDED', 'FAILED')
           AND NOT ${IS_SELF_MUTATION}
         ORDER BY coalesce(e.completed_at, e.created_at) DESC, e.created_at DESC
         LIMIT 1
      ) latest ON latest.status = 'FAILED'
     WHERE m.step_key = ${BUILD_IMAGE_STEP_KEY} AND m.plugin_name = ${BUILD_IMAGE_PLUGIN} AND m.plugin_publisher IS NULL
       AND m.plugin_version = ${releaseVersion}
     ORDER BY m.org_id, m.pipeline_id
  `);
  const byOrg = new Map<string, string[]>();
  for (const r of rows) {
    const ids = byOrg.get(r.org_id) ?? [];
    if (!ids.includes(r.pipeline_id)) ids.push(r.pipeline_id);
    byOrg.set(r.org_id, ids);
  }
  const orgs = [...byOrg.entries()].map(([orgId, pipelineIds]) => ({ orgId, pipelines: pipelineIds.length, pipelineIds }));
  return { releaseVersion, totalPipelines: orgs.reduce((n, o) => n + o.pipelines, 0), orgs };
}

/** The current platform default (elevated read), or null. */
export async function readPlatformDefaultRelease(db: SqlExecutor): Promise<string | null> {
  const [row] = await executeRows<{ release_version: string }>(db, sql`
    SELECT release_version FROM toolchain_platform_default WHERE singleton = true
  `);
  return row?.release_version ?? null;
}

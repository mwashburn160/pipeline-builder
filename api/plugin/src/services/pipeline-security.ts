// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A PIPELINE's plugin security, from the plugin service's side:
 *
 *  - {@link pipelineSecurity} — per step: what its config resolves to, what synth
 *    was last told (`pipeline_step_lookups`), the version's current scan state and
 *    the pipeline's exposures with their acceptance state;
 *  - {@link runtimeCheck} — the CURRENT grade of the image digests a pipeline is
 *    about to run (flag, KEV, fixable findings, the org's threshold, compliance,
 *    the pipeline's acceptances). It never says "block": vulnerability state only
 *    grades, and an `error` or louder tells the pipeline's owners (N32);
 *  - {@link triagePipelineExposure} — accept (time-boxed, with a reason; KEV only
 *    when asked for explicitly), dismiss as a false positive, or reopen.
 */

import {
  assessVersionVulns, ErrorCode, maxSeverity, recordAudit, scanFreshness, severityAtLeast, SYSTEM_ACTOR_ID, versionScanFacts,
  type ScannedRecord, type VulnSeverity, type VulnWarning,
} from '@pipeline-builder/api-core';
import {
  executeRows, pipelineExposures, pipelineStepLookups, scopeOrgIds, stepLabelOf, triageExposure, exposureById,
  withTenantTx, type PipelineExposure, type ResolutionScope,
} from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';

import { EcosystemError } from './ecosystem/context.js';
import { elevated } from './ecosystem/store.js';
import { notifyPipelineVulnerable } from './plugin-security-notifications.js';
import { acceptanceFor, acceptancesFor, consumptionPolicyFor } from '../helpers/lookup-vuln-policy.js';

/** A plugin record an image digest belongs to, in the caller's scope. */
export interface DigestRecord extends ScannedRecord {
  id: string;
  source: 'org' | 'listing';
  publisher: string | null;
  state: 'live' | 'inactive' | 'yanked' | 'deleted';
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * The records each digest belongs to: the org's (or, for a team, its root's)
 * own plugin rows — deleted ones too, since a running pipeline may still be on
 * one — then any ecosystem listing version. Elevated read, scoped by the
 * explicit org ids (listing versions are instance-wide).
 */
export async function recordsByDigest(scope: ResolutionScope, digests: readonly string[]): Promise<Map<string, DigestRecord>> {
  const wanted = [...new Set(digests.filter((d) => SHA256.test(d)))];
  const out = new Map<string, DigestRecord>();
  if (wanted.length === 0) return out;
  const orgIds = scopeOrgIds(scope);
  const rows = await elevated(async (tx) => {
    const own = await executeRows<Record<string, unknown>>(tx, sql`
      SELECT id::text AS id, name, version, image_digest, build_type, plugin_type, scanned_at, scan_summary, scan_flagged_at, scan_flag,
             vuln_high_fixable, deleted_at IS NOT NULL AS deleted, is_active, yanked_at IS NOT NULL AS yanked
        FROM plugins
       WHERE image_digest = ANY(${wanted}) AND lower(org_id) = ANY(${orgIds})
       ORDER BY deleted_at NULLS FIRST, updated_at DESC
    `);
    const listed = await executeRows<Record<string, unknown>>(tx, sql`
      SELECT v.id::text AS id, l.name, v.version, v.image_digest, v.scanned_at, v.scan_summary, v.scan_flagged_at, v.scan_flag,
             v.vuln_high_fixable, v.yanked_at IS NOT NULL AS yanked, p.handle AS publisher
        FROM plugin_listing_versions v
        JOIN plugin_listings l ON l.id = v.listing_id
        JOIN publishers p ON p.id = l.publisher_id
       WHERE v.image_digest = ANY(${wanted})
    `);
    return { own, listed };
  });
  for (const r of rows.own) {
    const digest = String(r.image_digest);
    if (out.has(digest)) continue;
    out.set(digest, {
      id: String(r.id),
      source: 'org',
      publisher: null,
      name: String(r.name),
      version: String(r.version),
      imageDigest: digest,
      buildType: r.build_type as string,
      pluginType: r.plugin_type as string,
      scannedAt: r.scanned_at as Date | null,
      scanSummary: r.scan_summary,
      scanFlaggedAt: r.scan_flagged_at as Date | null,
      scanFlag: r.scan_flag,
      vulnHighFixable: r.vuln_high_fixable,
      state: r.deleted ? 'deleted' : r.yanked ? 'yanked' : r.is_active === false ? 'inactive' : 'live',
    });
  }
  for (const r of rows.listed) {
    const digest = String(r.image_digest);
    if (out.has(digest)) continue;
    out.set(digest, {
      id: String(r.id),
      source: 'listing',
      publisher: (r.publisher as string | null) ?? null,
      name: String(r.name),
      version: String(r.version),
      imageDigest: digest,
      buildType: 'build_image',
      pluginType: 'CodeBuildStep',
      scannedAt: r.scanned_at as Date | null,
      scanSummary: r.scan_summary,
      scanFlaggedAt: r.scan_flagged_at as Date | null,
      scanFlag: r.scan_flag,
      vulnHighFixable: r.vuln_high_fixable,
      state: r.yanked ? 'yanked' : 'live',
    });
  }
  return out;
}

/** A runtime-check / security-view grade: `ok` when there is nothing to say. */
export type Grade = 'ok' | VulnSeverity;

const louder = (a: Grade, b: Grade): Grade => (a === 'ok' ? b : b === 'ok' ? a : maxSeverity(a, b));

/** One step of `POST /plugins/runtime-check`. */
export interface RuntimeCheckStep {
  stepKey: string;
  imageDigest: string;
  verdict: Grade;
  plugin: string | null;
  version: string | null;
  reasons: Array<{ code: string; severity: VulnSeverity; message: string }>;
}

/** Validate the runtime-check body; throws a 400. */
export function parseRuntimeCheck(body: unknown): { pipelineId: string; steps: Array<{ stepKey: string; imageDigest: string }>; executionId?: string } {
  const bad = (m: string): never => { throw new EcosystemError(ErrorCode.VALIDATION_ERROR, m); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.pipelineId !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.pipelineId)) bad('pipelineId must be a pipeline id');
  if (!Array.isArray(b.steps) || b.steps.length === 0 || b.steps.length > 200) bad('steps must be a non-empty array (at most 200)');
  const steps = (b.steps as unknown[]).map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s.stepKey !== 'string' || !s.stepKey.trim() || s.stepKey.length > 512) bad(`steps[${i}].stepKey must be a non-empty string`);
    if (typeof s.imageDigest !== 'string' || !SHA256.test(s.imageDigest)) bad(`steps[${i}].imageDigest must be a sha256 digest`);
    return { stepKey: (s.stepKey as string).trim(), imageDigest: s.imageDigest as string };
  });
  // Optional: the pipeline execution that ran the check (CodePipeline
  // execution id), so a flagged verdict on the trail names WHICH run was told.
  if (b.executionId !== undefined && (typeof b.executionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.executionId))) {
    bad('executionId must be an execution id (at most 128 of [A-Za-z0-9._:-])');
  }
  return { pipelineId: (b.pipelineId as string).toLowerCase(), steps, ...(typeof b.executionId === 'string' ? { executionId: b.executionId } : {}) };
}

/**
 * `POST /plugins/runtime-check`: the CURRENT grade of each step's image for the
 * caller's org and this pipeline. A digest no plugin in the caller's scope owns
 * is a `warning` (`UNKNOWN_IMAGE`) — nothing is known about it. Each step graded
 * `error` or louder notifies the pipeline's owners (N32, deduplicated).
 */
export async function runtimeCheck(
  scope: ResolutionScope,
  pipeline: { id: string; name: string | null },
  steps: ReadonlyArray<{ stepKey: string; imageDigest: string }>,
  by: { actorId: string; executionId?: string } = { actorId: SYSTEM_ACTOR_ID },
): Promise<{ verdict: Grade; steps: RuntimeCheckStep[] }> {
  const [records, policy, acceptances] = await Promise.all([
    recordsByDigest(scope, steps.map((s) => s.imageDigest)),
    consumptionPolicyFor(scope),
    acceptancesFor(scope.orgId, pipeline.id),
  ]);
  const assessed = new Map<string, Promise<VulnWarning[]>>();
  const out: RuntimeCheckStep[] = [];
  let verdict: Grade = 'ok';
  for (const step of steps) {
    const record = records.get(step.imageDigest);
    if (!record) {
      const reasons = [{ code: 'UNKNOWN_IMAGE', severity: 'warning' as const, message: `Image ${step.imageDigest} is not a plugin version your organization can resolve; nothing is known about its vulnerabilities.` }];
      out.push({ stepKey: step.stepKey, imageDigest: step.imageDigest, verdict: 'warning', plugin: null, version: null, reasons });
      verdict = louder(verdict, 'warning');
      continue;
    }
    let pending = assessed.get(step.imageDigest);
    if (!pending) {
      pending = assessVersionVulns({ orgId: scope.orgId, record, policy, acceptance: acceptanceFor(acceptances, record) }).then((a) => a.warnings);
      assessed.set(step.imageDigest, pending);
    }
    const reasons: RuntimeCheckStep['reasons'] = (await pending).map((w) => ({ code: w.code, severity: w.severity, message: w.message }));
    if (record.state !== 'live') {
      reasons.push({ code: `PLUGIN_${record.state.toUpperCase()}`, severity: 'warning', message: `${record.name}@${record.version} is ${record.state} in the catalog; the pipeline still runs it.` });
    }
    const stepVerdict = reasons.reduce<Grade>((g, r) => louder(g, r.severity), 'ok');
    const plugin = record.publisher ? `${record.publisher}/${record.name}` : record.name;
    out.push({ stepKey: step.stepKey, imageDigest: step.imageDigest, verdict: stepVerdict, plugin, version: record.version, reasons });
    verdict = louder(verdict, stepVerdict);
    if (stepVerdict !== 'ok' && severityAtLeast(stepVerdict, 'error')) {
      void notifyPipelineVulnerable({
        orgId: scope.orgId,
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        stepKey: step.stepKey,
        plugin,
        version: record.version,
        severity: stepVerdict,
        warnings: reasons.filter((r) => severityAtLeast(r.severity, 'error')),
        trigger: 'runtime-check',
      });
      // A running pipeline was told one of its images is unsafe — the durable
      // record of WHEN it knew (the notice is deduplicated; this is not).
      recordAudit({
        action: 'pipeline.runtime_check.flagged',
        actorId: by.actorId,
        orgId: scope.orgId,
        targetType: 'pipeline',
        targetId: pipeline.id,
        outcome: 'success',
        details: {
          pipelineId: pipeline.id,
          stepKey: step.stepKey,
          imageDigest: step.imageDigest,
          plugin,
          version: record.version,
          verdict: stepVerdict,
          codes: [...new Set(reasons.filter((r) => severityAtLeast(r.severity, 'error')).map((r) => r.code))],
          ...(by.executionId ? { executionId: by.executionId } : {}),
        },
      });
    }
  }
  return { verdict, steps: out };
}

/** Exposures as the API returns them (dates as ISO). */
export function shapeExposure(e: PipelineExposure) {
  return {
    id: e.id,
    pipelineId: e.pipelineId,
    plugin: e.pluginPublisher ? `${e.pluginPublisher}/${e.pluginName}` : e.pluginName,
    pluginPublisher: e.pluginPublisher,
    pluginName: e.pluginName,
    version: e.pluginVersion,
    imageDigest: e.imageDigest,
    source: e.source,
    criticalCount: e.criticalCount,
    highCount: e.highCount,
    topFindings: e.topFindings,
    findingCount: e.findingKeys.length,
    triageState: e.triageState,
    acceptance: e.triageState === 'accepted' || e.acceptanceActive
      ? { active: e.acceptanceActive, until: e.acceptedUntil?.toISOString() ?? null, findingCount: e.acceptedFindingKeys.length, kev: e.acceptedKev }
      : null,
    triageReason: e.triageReason,
    triagedBy: e.triagedBy,
    triagedAt: e.triagedAt?.toISOString() ?? null,
    flaggedAt: e.flaggedAt.toISOString(),
    fixedAt: e.fixedAt?.toISOString() ?? null,
  };
}

/**
 * `GET /plugins/pipelines/:pipelineId/security`: per step, the declared
 * resolution, the last lookup synth sent with this step's context, the version's
 * scan state now, and the exposures on it.
 */
export async function pipelineSecurity(scope: ResolutionScope, pipeline: { id: string; name: string | null }) {
  const orgId = scope.orgId;
  const [declared, lookups, exposures] = await Promise.all([
    withTenantTx((tx) => executeRows<{ stage_name: string; step_name: string; plugin_publisher: string | null; plugin_name: string; declared_version: string | null; resolved_version: string | null; resolved_digest: string | null; within_policy: boolean; computed_at: Date }>(tx, sql`
      SELECT stage_name, step_name, plugin_publisher, plugin_name, declared_version, resolved_version, resolved_digest, within_policy, computed_at
        FROM pipeline_plugin_resolution WHERE pipeline_id = ${pipeline.id} AND lower(org_id) = ${orgId.toLowerCase()}
    `)),
    pipelineStepLookups(orgId, pipeline.id),
    pipelineExposures(orgId, pipeline.id),
  ]);
  const keys = new Set<string>([...declared.map((d) => stepLabelOf(d.stage_name, d.step_name)), ...lookups.map((l) => l.stepKey)]);
  const digests = [...declared.map((d) => d.resolved_digest), ...lookups.map((l) => l.imageDigest)].filter((d): d is string => !!d);
  const [records, policy] = await Promise.all([recordsByDigest(scope, digests), consumptionPolicyFor(scope)]);
  const acceptances = await acceptancesFor(orgId, pipeline.id);
  const steps = [];
  let grade: Grade = 'ok';
  for (const stepKey of [...keys].sort()) {
    const d = declared.find((x) => stepLabelOf(x.stage_name, x.step_name) === stepKey) ?? null;
    const l = lookups.find((x) => x.stepKey === stepKey) ?? null;
    const digest = l?.imageDigest ?? d?.resolved_digest ?? null;
    const name = l?.pluginName ?? d?.plugin_name ?? null;
    const version = l?.resolvedVersion ?? d?.resolved_version ?? null;
    const record = digest ? records.get(digest) ?? null : null;
    const facts = record ? versionScanFacts(record) : null;
    const assessment = record ? await assessVersionVulns({ orgId, record, policy, acceptance: acceptanceFor(acceptances, record), compliance: false }) : null;
    const severity: Grade = assessment?.severity ?? 'ok';
    grade = louder(grade, severity);
    steps.push({
      stepKey,
      plugin: name ? ((l?.pluginPublisher ?? d?.plugin_publisher) ? `${l?.pluginPublisher ?? d?.plugin_publisher}/${name}` : name) : null,
      declaredVersion: d?.declared_version ?? l?.requestedVersion ?? null,
      version,
      digest,
      withinPolicy: d?.within_policy ?? null,
      resolutionComputedAt: d?.computed_at ? new Date(d.computed_at).toISOString() : null,
      lastLookupAt: l?.lookedUpAt ? new Date(l.lookedUpAt).toISOString() : null,
      warnings: l?.warnings ?? [],
      refusal: l?.refusal ?? null,
      catalogState: record?.state ?? null,
      scan: facts && record ? {
        flagged: facts.flagged,
        kev: facts.kev,
        criticalFixable: facts.criticalFixable,
        highFixable: facts.highFixable,
        critical: facts.critical,
        high: facts.high,
        scannedAt: facts.scannedAt?.toISOString() ?? null,
        stale: scanFreshness(record).state === 'stale',
        unscanned: scanFreshness(record).state === 'unscanned',
      } : null,
      severity,
      currentWarnings: assessment?.warnings.map((w) => ({ code: w.code, severity: w.severity, message: w.message })) ?? [],
      exposures: exposures.filter((e) => e.pluginName === name && e.pluginVersion === version && (!digest || !e.imageDigest || e.imageDigest === digest)).map(shapeExposure),
    });
  }
  return { pipeline, severity: grade, steps, exposures: exposures.map(shapeExposure) };
}

/** `PLUGIN_RISK_ACCEPTANCE_MAX_DAYS` (default 90): the longest an acceptance may run. */
export function riskAcceptanceMaxDays(): number {
  const n = Number.parseInt(process.env.PLUGIN_RISK_ACCEPTANCE_MAX_DAYS ?? '', 10);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 90;
}

/** The validated triage body. */
export interface TriageBody {
  action: 'accept' | 'false_positive' | 'reopen';
  reason?: string;
  acceptedUntil?: Date;
  kev: boolean;
}

/** Validate a triage body; throws a 400. */
export function parseTriage(body: unknown, now = new Date()): TriageBody {
  const bad = (m: string): never => { throw new EcosystemError(ErrorCode.VALIDATION_ERROR, m); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('body must be an object');
  const b = body as Record<string, unknown>;
  if (b.action !== 'accept' && b.action !== 'false_positive' && b.action !== 'reopen') bad('action must be accept, false_positive or reopen');
  const reason = typeof b.reason === 'string' ? b.reason.trim() : undefined;
  if (reason !== undefined && reason.length > 2000) bad('reason must be at most 2000 characters');
  if (b.kev !== undefined && typeof b.kev !== 'boolean') bad('kev must be a boolean');
  const out: TriageBody = { action: b.action as TriageBody['action'], ...(reason ? { reason } : {}), kev: b.kev === true };
  if (out.action === 'accept') {
    if (!reason) bad('Accepting a risk needs a reason');
    const until = typeof b.acceptedUntil === 'string' ? new Date(b.acceptedUntil) : null;
    if (!until || Number.isNaN(until.getTime())) bad('Accepting a risk needs acceptedUntil (an ISO date)');
    if (until!.getTime() <= now.getTime()) bad('acceptedUntil must be in the future');
    const max = riskAcceptanceMaxDays();
    if (until!.getTime() > now.getTime() + max * 86_400_000) bad(`acceptedUntil can be at most ${max} days away (PLUGIN_RISK_ACCEPTANCE_MAX_DAYS)`);
    out.acceptedUntil = until!;
  }
  if (out.action === 'false_positive' && !reason) bad('Dismissing a finding as a false positive needs a reason');
  return out;
}

const TRIAGE_ACTIONS = {
  accept: { state: 'accepted', audit: 'pipeline.vuln.accepted' },
  false_positive: { state: 'false_positive', audit: 'pipeline.vuln.false_positive' },
  reopen: { state: 'open', audit: 'pipeline.vuln.reopened' },
} as const;

/**
 * Triage one exposure of a pipeline (and its declared/deployed sibling).
 * Accepting a version with KEV findings needs `kev: true` — an acceptance never
 * covers a known-exploited finding by implication. Audited.
 */
export async function triagePipelineExposure(
  scope: ResolutionScope,
  pipelineId: string,
  exposureId: string,
  body: TriageBody,
  userId: string,
) {
  const orgId = scope.orgId;
  const target = await exposureById(orgId, exposureId);
  if (!target || target.pipelineId !== pipelineId) throw new EcosystemError(ErrorCode.NOT_FOUND, 'Exposure not found');
  if (target.fixedAt) throw new EcosystemError(ErrorCode.CONFLICT, 'This exposure is closed: the pipeline is no longer on that version.');
  let kevPresent = false;
  if (body.action === 'accept') {
    const record = target.imageDigest ? (await recordsByDigest(scope, [target.imageDigest])).get(target.imageDigest) : undefined;
    kevPresent = record ? versionScanFacts(record).kev > 0 : target.topFindings.some((f) => (f as { kev?: unknown }).kev === true);
    if (kevPresent && !body.kev) {
      throw new EcosystemError(ErrorCode.VALIDATION_ERROR, 'This version has findings on the CISA Known Exploited Vulnerabilities list; accepting them needs kev: true.');
    }
  }
  const action = TRIAGE_ACTIONS[body.action];
  const rows = await triageExposure(orgId, exposureId, {
    state: action.state,
    ...(body.reason ? { reason: body.reason } : {}),
    ...(body.acceptedUntil ? { acceptedUntil: body.acceptedUntil } : {}),
    kev: body.action === 'accept' && kevPresent && body.kev,
    actor: userId,
  });
  recordAudit({
    action: action.audit,
    actorId: userId,
    orgId,
    targetType: 'pipeline',
    targetId: pipelineId,
    details: {
      exposureIds: rows.map((r) => r.id),
      plugin: target.pluginPublisher ? `${target.pluginPublisher}/${target.pluginName}` : target.pluginName,
      version: target.pluginVersion,
      imageDigest: target.imageDigest,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.action === 'accept' ? { acceptedUntil: body.acceptedUntil!.toISOString(), kev: kevPresent && body.kev, findings: target.findingKeys.length } : {}),
      // WHICH advisories the triage covers (keys are `<id>|<package>|<version>`;
      // the ids alone are what a reviewer searches by).
      advisoryIds: [...new Set(target.findingKeys.map((k) => k.split('|')[0]!))].slice(0, 200),
      previousState: target.triageState,
    },
  });
  return rows.map(shapeExposure);
}

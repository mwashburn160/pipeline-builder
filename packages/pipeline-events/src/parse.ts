// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SQSRecord } from 'aws-lambda';
import { codeBuildIdOf, readBuildCompute, readSynthFailure } from './failure-reason.js';
import { classifySource, resolveCommitInfo } from './scm.js';
import { MAX_ATTR, resolvePipeline } from './tags.js';
import { log } from './util.js';

// Event parsing: an SQS record → the normalized reporting event.

export interface ParsedEvent {
  /**
   * Resolved platform orgId (from the pipeline's OrgId tag; null when untagged).
   * INTERNAL — used only to key the per-org GitHub token and to attribute
   * ingest-health. Stripped from the payload POSTed to /reports/events (which
   * resolves org from the pipeline registry, not the body).
   */
  orgId: string | null;
  pipelineId: string;
  eventSource: string;
  eventType: string;
  status: string;
  executionId?: string;
  stageName?: string;
  actionName?: string;
  /** Human-readable failure reason, from an Action event's
   *  `execution-result.external-execution-summary`. The log URL + error-code
   *  stay in `detail` for drill-down. */
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Source commit id (DORA deploy attribution). Undefined when the event
   *  carries no source revision — stored NULL downstream. */
  commitSha?: string;
  /** Source branch/ref (DORA deploy attribution). Undefined when unavailable. */
  commitRef?: string;
  /** Oldest-unshipped commit timestamp (ISO 8601) for the range since the last
   *  deploy — resolved in-account. Undefined when unresolvable. */
  commitTimestamp?: string;
  /** Number of commits in the resolved range (≥1). Undefined when unresolvable. */
  commitCount?: number;
  /**
   * The compute size a terminal CodeBuild action ran on (`SMALL` … `X2_LARGE`),
   * read from AWS. Undefined for a non-CodeBuild action, a non-terminal event,
   * or when the read failed — the ingest then records the action as UNMEASURED
   * rather than as free, which is what makes the coverage gap visible instead of
   * looking like idleness.
   *
   * Its own field rather than a `detail` key, for the reason `failure` has one:
   * `detail` is bounded at 8 KB and already sheds content under that bound, so a
   * one-word field riding inside it is a field that can be dropped by an
   * unrelated payload getting large.
   */
  computeType?: string;
  /** Deploy environment — set only when the event's stage is listed in the
   *  pipeline's `pb.deploys` tag. Undefined otherwise (⇒ not a deploy). */
  environment?: string;
  /** The EventBridge event `id` (≤128) — lets the server's audit trail name the
   *  exact AWS event a row came from. Undefined when the body carries none. */
  sourceEventId?: string;
  /** The SQS record's messageId (≤128) — the delivery that carried the event. */
  sourceMessageId?: string;
  detail: Record<string, unknown>;
}

/** Cap on `sourceEventId` / `sourceMessageId` — the reporting ingest's max. */
const MAX_SOURCE_ID = 128;

/** A non-empty string capped to `MAX_SOURCE_ID`, else undefined. */
function sourceId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_SOURCE_ID) : undefined;
}

/** Cap on the stored failure summary — CodeBuild/Deploy summaries can be long. */
const MAX_ERROR_MESSAGE = 4000;

/** Headroom under the reporting ingest's 8 KB serialized `detail` bound. */
const MAX_DETAIL_BYTES = 7500;

/** First non-empty string among the candidates, capped to the ingest max. */
function firstAttr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v.slice(0, MAX_ATTR);
  }
  return undefined;
}

/**
 * Best-effort extraction of the source commit id + ref (and the revision URL, used
 * only in-account to classify the source type for commit-range resolution) from a
 * CodePipeline event detail. CodePipeline surfaces the source revision under a few
 * shapes depending on the event type / source-action; we check the known ones and
 * leave the fields undefined when none are present (NULL downstream). Never pulls an
 * ARN/account id: only revision/branch/url string fields are read; the revisionUrl
 * is consumed in-account (source classification) and never forwarded on its own.
 */
function extractCommit(detail: Record<string, unknown>): { commitSha?: string; commitRef?: string; revisionUrl?: string } {
  // `source-revisions` (kebab, EventBridge) / `sourceRevisions` (camel) — first entry.
  const revs = (detail['source-revisions'] ?? detail.sourceRevisions) as
    | Array<Record<string, unknown>> | undefined;
  const firstRev = Array.isArray(revs) ? revs[0] : undefined;
  // On source actions the revision id can also ride on `execution-result`.
  const execResult = detail['execution-result'] as Record<string, unknown> | undefined;

  const commitSha = firstAttr(
    detail.commitId,
    detail.revisionId,
    firstRev?.revisionId,
    execResult?.revisionId,
  );
  const commitRef = firstAttr(
    detail.commitRef,
    detail.branch,
    detail.sourceBranch,
    firstRev?.branchName,
    firstRev?.branch,
  );
  const revisionUrl = typeof firstRev?.revisionUrl === 'string' ? firstRev.revisionUrl : undefined;

  return { ...(commitSha && { commitSha }), ...(commitRef && { commitRef }), ...(revisionUrl && { revisionUrl }) };
}

function classifyEvent(detailType: string): { eventType: string; eventSource: string } {
  if (detailType.includes('Pipeline Execution')) return { eventType: 'PIPELINE', eventSource: 'codepipeline' };
  if (detailType.includes('Stage Execution')) return { eventType: 'STAGE', eventSource: 'codepipeline' };
  if (detailType.includes('Action Execution')) return { eventType: 'ACTION', eventSource: 'codepipeline' };
  // CodeBuild "Build State" events identify a build *project*, not a pipeline, so
  // parseRecord drops them on the `eventSource !== 'codepipeline'` check below —
  // the 'BUILD' eventType is never persisted here (plugin BUILD events are
  // recorded directly by the plugin service). The 'codebuild' source is what
  // routes the drop; keep this branch only for that.
  if (detailType.includes('Build State')) return { eventType: 'BUILD', eventSource: 'codebuild' };
  return { eventType: 'PIPELINE', eventSource: 'codepipeline' };
}

/** Parse + resolve one record to a reportable event, or null to skip it. */
export async function parseRecord(record: SQSRecord): Promise<ParsedEvent | null> {
  let event: {
    'id'?: string;
    'detail-type': string;
    'source': string;
    'detail': Record<string, unknown>;
    'time': string;
    'region': string;
    'account': string;
  };
  // A malformed body is a dead message (retrying won't help) — log + skip it so
  // it can't fail the whole batch. Resolution errors below (e.g. AccessDenied)
  // are NOT caught here: those are transient/infra and must propagate to retry.
  try {
    event = JSON.parse(record.body);
  } catch (err) {
    log.warn('Skipping SQS record with unparseable body', { messageId: record.messageId, error: String(err) });
    return null;
  }

  const { eventType, eventSource } = classifyEvent(event['detail-type']);
  const detail = { ...event.detail };
  // The raw account never needs to leave AWS now — drop it from the payload.
  delete detail.account;

  // CodeBuild "Build State" events identify a build *project*, not a pipeline,
  // and a project can be shared across pipelines — there's no clean 1:1 mapping
  // to a pipeline id, so skip them.
  if (eventSource !== 'codepipeline') {
    log.warn('Skipping non-CodePipeline event (no pipeline tag to resolve)', { detailType: event['detail-type'] });
    return null;
  }

  const pipelineName = detail.pipeline as string | undefined;
  if (!pipelineName) {
    log.warn('CodePipeline event missing pipeline name — skipping');
    return null;
  }

  // Resolve the pipeline's pb.pipeline-id (= platform pipelineId) + pb.deploys map.
  // The ARN is only a transient handle for the tag lookup; it is never stored.
  const arn = `arn:aws:codepipeline:${event.region}:${event.account}:${pipelineName}`;
  const { pipelineId, orgId, deploys } = await resolvePipeline(arn, event.region);
  if (!pipelineId) return null; // untagged / unregistered → skip

  // AWS does not always send `start-time`. `event.time` stands in for it so the
  // row still lands in the report windows, which filter on `started_at` — but it
  // is NOT a measurement, and the duration below must not be computed from it.
  const declaredStart = detail['start-time'] as string | undefined;
  const startedAt = declaredStart || event.time;
  const state = detail.state as string;

  let durationMs: number | undefined;
  let completedAt: string | undefined;

  if (['SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED'].includes(state)) {
    completedAt = event.time;
    // ONLY from a start AWS actually declared. With the fallback, `startedAt` and
    // `completedAt` are both `event.time` on a terminal event, so the duration came
    // out as exactly 0 — reported as a real measurement, dragging every average and
    // p95 stage duration toward zero with no sign anything was missing. Unknown is
    // left unknown (NULL), which the reports already handle.
    if (declaredStart) {
      const ms = new Date(completedAt).getTime() - new Date(declaredStart).getTime();
      if (Number.isFinite(ms) && ms >= 0) durationMs = ms;
    }
  }

  // Promote the failure reason to a typed field. On Action events AWS puts the
  // human-readable summary (and a log URL + error-code, which stay in `detail`)
  // under `execution-result`.
  const result = detail['execution-result'] as { 'external-execution-summary'?: unknown } | undefined;
  const summary = result?.['external-execution-summary'];
  let errorMessage = typeof summary === 'string' && summary.length > 0
    ? summary.slice(0, MAX_ERROR_MESSAGE)
    : undefined;

  // A failed CodeBuild action may have printed a structured reason (the synth's
  // `PB_SYNTH_FAILURE` line — a refused plugin, with its code). CodeBuild's
  // summary never carries the build output, so read it from the build's log and
  // promote it: the code + message become the failure reason, the per-plugin
  // list rides in `detail.pbFailure`. Best-effort (see failure-reason.ts).
  // The compute size this action ran on, for the vCPU-minute figure Phase 4
  // measures. Only on a TERMINAL CodeBuild action: an in-progress event has no
  // duration to pair it with, so reading it there would spend an AWS call to
  // learn nothing. Best-effort — null forwards without the field.
  let computeType: string | undefined;
  if (eventType === 'ACTION' && ['SUCCEEDED', 'FAILED', 'STOPPED'].includes(state)) {
    const cbId = codeBuildIdOf(detail);
    computeType = (cbId ? await readBuildCompute(event.region, cbId) : null) ?? undefined;
  }

  if (eventType === 'ACTION' && state === 'FAILED') {
    const buildId = codeBuildIdOf(detail);
    const failure = buildId ? await readSynthFailure(event.region, buildId) : null;
    if (failure) {
      detail.pbFailure = failure;
      // The ingest bounds `detail` at 8 KB serialized; keep the codes, drop the
      // per-plugin prose if the whole thing would not fit.
      if (JSON.stringify(detail).length >= MAX_DETAIL_BYTES) {
        detail.pbFailure = { ...failure, plugins: failure.plugins.map(({ plugin, code }) => ({ plugin, code })) };
      }
      errorMessage = `${failure.code}: ${failure.message}`.slice(0, MAX_ERROR_MESSAGE);
    }
  }

  // Audit correlation back to the AWS side: which EventBridge event, carried by
  // which SQS delivery. Both are opaque ids (no ARN, no account).
  const sourceEventId = sourceId(event.id);
  const sourceMessageId = sourceId(record.messageId);

  // DORA deploy attribution — all optional: omitted (undefined) when the
  // event/pipeline doesn't carry them.
  const { commitSha, commitRef, revisionUrl } = extractCommit(detail);

  const executionId = detail['execution-id'] as string | undefined;
  const stageName = detail.stage as string | undefined;
  const actionName = detail.action as string | undefined;

  // Environment (⇒ isDeploy) is set ONLY when this event's stage is listed in the
  // pipeline's pb.deploys tag. PIPELINE events have no stage → never a deploy.
  const environment = stageName ? deploys.get(stageName) : undefined;

  // Resolve the commit range (oldest-unshipped timestamp + count) for any
  // event carrying a commit. Best-effort/in-account; omitted on any failure.
  // GATED on `DORA_ENABLED` (set by `setup-events --with-dora`): DORA lead time is an
  // advanced_reporting add-on, so orgs without it skip the SCM/secret cost entirely —
  // standard reporting (commitSha + all other fields) still forwards regardless.
  let commitTimestamp: string | undefined;
  let commitCount: number | undefined;
  if (commitSha && process.env.DORA_ENABLED === 'true') {
    const src = classifySource(revisionUrl);
    const info = await resolveCommitInfo(pipelineId, orgId, event.region, { sha: commitSha, ...src });
    commitTimestamp = info.commitTimestamp;
    commitCount = info.commitCount;
  }

  return {
    orgId,
    pipelineId,
    eventSource,
    eventType,
    status: state,
    executionId,
    stageName,
    actionName,
    errorMessage,
    startedAt,
    completedAt,
    durationMs,
    ...(commitSha && { commitSha }),
    ...(commitRef && { commitRef }),
    ...(commitTimestamp && { commitTimestamp }),
    ...(commitCount && { commitCount }),
    ...(environment && { environment }),
    ...(computeType && { computeType }),
    ...(sourceEventId && { sourceEventId }),
    ...(sourceMessageId && { sourceMessageId }),
    detail,
  };
}

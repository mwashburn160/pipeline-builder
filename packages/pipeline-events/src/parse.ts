// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SQSRecord } from 'aws-lambda';
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
  /** Deploy environment — set only when the event's stage is listed in the
   *  pipeline's `pb.deploys` tag. Undefined otherwise (⇒ not a deploy). */
  environment?: string;
  detail: Record<string, unknown>;
}

/** Cap on the stored failure summary — CodeBuild/Deploy summaries can be long. */
const MAX_ERROR_MESSAGE = 4000;

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

  const startedAt = (detail['start-time'] as string) || event.time;
  const state = detail.state as string;

  let durationMs: number | undefined;
  let completedAt: string | undefined;

  if (['SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED'].includes(state)) {
    completedAt = event.time;
    if (startedAt && completedAt) {
      const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
      if (ms >= 0) durationMs = ms;
    }
  }

  // Promote the failure reason to a typed field. On Action events AWS puts the
  // human-readable summary (and a log URL + error-code, which stay in `detail`)
  // under `execution-result`.
  const result = detail['execution-result'] as { 'external-execution-summary'?: unknown } | undefined;
  const summary = result?.['external-execution-summary'];
  const errorMessage = typeof summary === 'string' && summary.length > 0
    ? summary.slice(0, MAX_ERROR_MESSAGE)
    : undefined;

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
    detail,
  };
}

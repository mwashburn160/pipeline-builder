// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

// AWS Lambda's Node runtime bundles @aws-sdk v3, so the CodePipeline client is
// loaded lazily via dynamic import() — a static workspace dependency on
// @aws-sdk/client-codepipeline would perturb the shared @aws-sdk version tree
// and break other packages' typings. The dynamic import keeps it out of the
// static graph while staying ESM-correct (no `require` in a type:module package)
// and mockable. Minimal local types keep the call sites type-checked.
interface ListTagsOutput { tags?: Array<{ key?: string; value?: string }> }
interface CodePipelineClientLike { send(command: unknown): Promise<ListTagsOutput> }
interface CodePipelineModule {
  CodePipelineClient: new (config: { region: string }) => CodePipelineClientLike;
  ListTagsForResourceCommand: new (input: { resourceArn: string }) => unknown;
}
let codepipelineMod: CodePipelineModule | undefined;
async function loadCodePipeline(): Promise<CodePipelineModule> {
  if (!codepipelineMod) codepipelineMod = (await import('@aws-sdk/client-codepipeline')) as unknown as CodePipelineModule;
  return codepipelineMod;
}

/**
 * Pipeline event ingestion Lambda handler.
 *
 * Receives CodePipeline/CodeBuild events from SQS (sourced by EventBridge),
 * parses them into a normalized format, and POSTs them to the reporting service
 * via PLATFORM_BASE_URL.
 *
 * Authentication:
 * - PLATFORM_TOKEN env var (preferred — no Secrets Manager call)
 * - PLATFORM_SECRET_NAME env var → reads the JWT (password) from Secrets Manager
 *
 * Environment variables:
 * - PLATFORM_BASE_URL — Base URL of the platform
 * - PLATFORM_TOKEN — JWT token (set directly, or)
 * - PLATFORM_SECRET_NAME — Secrets Manager secret containing { password: <JWT> }
 */

const log = {
  info: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'INFO', message: msg, data, ts: new Date().toISOString() })),
  warn: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'WARN', message: msg, data, ts: new Date().toISOString() })),
  error: (msg: string, data?: unknown) => console.error(JSON.stringify({ level: 'ERROR', message: msg, data, ts: new Date().toISOString() })),
};

// ── PIPELINE_EVENT_ID resolution ─────────────────────────
// Pipelines are tagged `PIPELINE_EVENT_ID=<pipelineId>` at CDK synth. We resolve
// that tag from the live CodePipeline (region-aware) and report against the id —
// the ARN/account never leave AWS, so there's no masking. Cached per ARN
// (warm-container) to avoid hammering the ListTags API.
//
// Requires the Lambda execution role to allow `codepipeline:ListTagsForResource`.
// AccessDenied is a config error (alert loudly); a missing tag is treated as
// "not yet registered" (skip).

const PIPELINE_EVENT_ID_TAG = 'PIPELINE_EVENT_ID';
const clientsByRegion = new Map<string, CodePipelineClientLike>();
// tag=null is a negative cache (resolved-but-untagged); `ts` lets negatives
// expire so a pipeline tagged AFTER its first event becomes resolvable without
// recycling the warm container. Positive results stay cached for the lifetime.
const eventIdByArn = new Map<string, { tag: string | null; ts: number }>();
const NEG_CACHE_TTL_MS = 5 * 60 * 1000;

async function pipelineClient(region: string): Promise<CodePipelineClientLike> {
  let client = clientsByRegion.get(region);
  if (!client) {
    const { CodePipelineClient } = await loadCodePipeline();
    client = new CodePipelineClient({ region });
    clientsByRegion.set(region, client);
  }
  return client;
}

/**
 * Resolve a CodePipeline's PIPELINE_EVENT_ID tag → the platform pipelineId.
 * Returns null when the pipeline has no such tag (unregistered). Throws on
 * AccessDenied so a missing IAM grant surfaces loudly instead of silently
 * dropping every event.
 */
async function resolvePipelineEventId(arn: string, region: string): Promise<string | null> {
  const cached = eventIdByArn.get(arn);
  // Serve a positive hit for the container lifetime; serve a negative hit only
  // until it expires (then re-resolve, in case the pipeline was since tagged).
  if (cached && (cached.tag !== null || Date.now() - cached.ts < NEG_CACHE_TTL_MS)) {
    return cached.tag;
  }
  try {
    const client = await pipelineClient(region);
    const { ListTagsForResourceCommand } = await loadCodePipeline();
    const out = await client.send(new ListTagsForResourceCommand({ resourceArn: arn }));
    const tag = out.tags?.find(t => t.key === PIPELINE_EVENT_ID_TAG)?.value ?? null;
    if (!tag) log.warn('Pipeline missing PIPELINE_EVENT_ID tag — skipping (register it?)', { arn });
    eventIdByArn.set(arn, { tag, ts: Date.now() });
    return tag;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'AccessDeniedException') {
      // Don't cache — this is a fixable misconfig, not a property of the pipeline.
      log.error('AccessDenied calling codepipeline:ListTagsForResource — grant it to the Lambda role', { arn, error: name });
      throw err;
    }
    log.error('Failed to resolve PIPELINE_EVENT_ID tag', { arn, error: name ?? String(err) });
    return null;
  }
}

// ─── Auth ───────────────────────────────────────────────

let cachedToken: string | null = null;

async function getAuthToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  // Path 1: PLATFORM_TOKEN env var (no Secrets Manager call)
  if (process.env.PLATFORM_TOKEN) {
    cachedToken = process.env.PLATFORM_TOKEN;
    log.info('Using PLATFORM_TOKEN from environment');
    return cachedToken;
  }

  // Path 2: PLATFORM_SECRET_NAME → read from Secrets Manager
  const secretName = process.env.PLATFORM_SECRET_NAME;
  if (!secretName) {
    throw new Error('PLATFORM_TOKEN or PLATFORM_SECRET_NAME environment variable is required');
  }

  log.info(`Fetching token from Secrets Manager: ${secretName}`);
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));

  if (!response.SecretString) throw new Error(`Secret "${secretName}" is empty`);

  const secret = JSON.parse(response.SecretString) as Record<string, string>;
  // store-token writes the JWT in `password` (the canonical field — also used by
  // CodeBuild secretsManagerCredentials, the plugin-lookup Lambda, and token-renew).
  const token = secret.password;
  if (!token) {
    throw new Error('Secret missing JWT (password) — run "pipeline-manager store-token" to generate');
  }

  cachedToken = token;
  log.info('Using stored JWT token from Secrets Manager');
  return cachedToken;
}

// ─── Event Parsing ──────────────────────────────────────

interface ParsedEvent {
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
  detail: Record<string, unknown>;
}

/** Cap on the stored failure summary — CodeBuild/Deploy summaries can be long. */
const MAX_ERROR_MESSAGE = 4000;

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
async function parseRecord(record: SQSRecord): Promise<ParsedEvent | null> {
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
  // to a PIPELINE_EVENT_ID, so skip them (they were effectively dropped before
  // too, since detail.pipeline was undefined and never matched the registry).
  if (eventSource !== 'codepipeline') {
    log.warn('Skipping non-CodePipeline event (no pipeline tag to resolve)', { detailType: event['detail-type'] });
    return null;
  }

  const pipelineName = detail.pipeline as string | undefined;
  if (!pipelineName) {
    log.warn('CodePipeline event missing pipeline name — skipping');
    return null;
  }

  // Resolve the pipeline's PIPELINE_EVENT_ID tag (= platform pipelineId). The
  // ARN is only a transient handle for the tag lookup; it is never stored.
  const arn = `arn:aws:codepipeline:${event.region}:${event.account}:${pipelineName}`;
  const pipelineId = await resolvePipelineEventId(arn, event.region);
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

  return {
    pipelineId,
    eventSource,
    eventType,
    status: state,
    executionId: detail['execution-id'] as string | undefined,
    stageName: detail.stage as string | undefined,
    actionName: detail.action as string | undefined,
    errorMessage,
    startedAt,
    completedAt,
    durationMs,
    detail,
  };
}

// ─── Handler ────────────────────────────────────────────

export const handler = async (event: SQSEvent): Promise<void> => {
  const baseUrl = process.env.PLATFORM_BASE_URL;
  if (!baseUrl) throw new Error('PLATFORM_BASE_URL environment variable is required');

  // Parse + resolve all records (tag lookups run concurrently); drop intentional
  // skips (null). A malformed record BODY is handled inside parseRecord (logged +
  // skipped) so one bad message can't fail the whole batch — while genuine infra
  // errors (e.g. AccessDenied on the tag lookup) still propagate so a missing IAM
  // grant surfaces and SQS retries the batch.
  const events = (await Promise.all(event.Records.map(parseRecord)))
    .filter((e): e is ParsedEvent => e !== null);
  if (events.length === 0) {
    log.info('No resolvable CodePipeline events in batch');
    return;
  }

  // POST batch to reporting service. On a 401/403 the cached JWT has likely
  // expired — drop it, re-fetch, and retry ONCE so an expired token doesn't
  // permanently brick a warm container.
  const post = (token: string) => fetch(`${baseUrl}/api/reports/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
  let res = await post(await getAuthToken());
  if (res.status === 401 || res.status === 403) {
    log.warn('Reporting API auth failed; refreshing token and retrying once', { status: res.status });
    cachedToken = null;
    res = await post(await getAuthToken());
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.error(`Reporting API returned ${res.status}`, { body });
    throw new Error(`Reporting API failed: ${res.status}`);
  }

  const result = await res.json() as Record<string, unknown>;
  log.info(`Ingested ${events.length} events`, { inserted: result.data });
};

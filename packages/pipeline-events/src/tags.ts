// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BoundedMap, CACHE_MAX_ENTRIES, log } from './util.js';

// AWS Lambda's Node runtime provides @aws-sdk v3, so the CodePipeline client is
// loaded lazily via dynamic import() — a static workspace dependency would
// perturb the shared @aws-sdk version tree. Minimal local types keep the call
// sites type-checked.
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

// Tag resolution: pb.pipeline-id + pb.deploys.
// Pipelines are tagged at CDK synth with:
//   pb.pipeline-id = <platform pipelineId>
//   pb.deploys     = <stage>:<env> pairs joined by '+', e.g.
//                    "Deploy-stg:staging+Deploy-prod:production"
// We resolve those tags from the live CodePipeline (region-aware). The ARN/account
// never leave AWS, so there's no masking. Cached per ARN (warm-container) to avoid
// hammering the ListTags API.
//
// Requires the Lambda execution role to allow `codepipeline:ListTagsForResource`.
// AccessDenied is a config error (alert loudly); a missing pb.pipeline-id tag is
// treated as "not yet registered" (skip).

const PIPELINE_ID_TAG = 'pb.pipeline-id';
const DEPLOYS_TAG = 'pb.deploys';
// Canonical per-pipeline org tag (applied at synth by pipeline-core). It is the
// RESOLVED org for every event of this pipeline — used to key the per-org GitHub
// token and to attribute ingest-health. orgId is a platform id, never an AWS
// account id, so it is safe to read/forward.
const ORG_ID_TAG = 'OrgId';
const clientsByRegion = new Map<string, CodePipelineClientLike>();


// `ts` lets BOTH outcomes expire: a negative (resolved-but-untagged) so a
// pipeline tagged AFTER its first event becomes resolvable, and a positive so a
// re-synth that changes `pb.deploys` (a stage renamed, an environment added) or
// `OrgId` is picked up without recycling the warm container — a lifetime cache
// would keep attributing deploys to stages that no longer exist.
const resolvedByArn = new BoundedMap<string, { pipelineId: string | null; orgId: string | null; deploys: Map<string, string>; ts: number }>(CACHE_MAX_ENTRIES);
const NEG_CACHE_TTL_MS = 5 * 60 * 1000;
const POS_CACHE_TTL_MS = 15 * 60 * 1000;

/** Resolved pipeline metadata read from the CodePipeline resource tags. */
export interface ResolvedPipeline {
  /** Platform pipelineId (pb.pipeline-id tag); null when untagged/unregistered. */
  pipelineId: string | null;
  /** Platform orgId (OrgId tag); null when the pipeline carries no org tag. */
  orgId: string | null;
  /** Map of deploy-stage name → environment (parsed from pb.deploys). Empty when none. */
  deploys: Map<string, string>;
}

/** Cap on commit/ref/environment fields — the ingest contract allows max 255. */
export const MAX_ATTR = 255;

/**
 * Parse the `pb.deploys` tag value into a stage→environment map. The value is
 * `<stage>:<env>` pairs joined by `+` (CodePipeline-tag-safe; no JSON). A stage
 * present here is a deploy; its mapped environment is what the forwarder stamps on
 * that stage's STAGE/ACTION events (DORA deploy attribution). Malformed pairs are
 * skipped defensively.
 */
function parseDeploys(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) return map;
  for (const pair of value.split('+')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const stage = pair.slice(0, idx).trim();
    const env = pair.slice(idx + 1).trim();
    if (stage && env) map.set(stage, env.slice(0, MAX_ATTR));
  }
  return map;
}

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
 * Resolve a CodePipeline's tags → the platform pipelineId (pb.pipeline-id) plus the
 * deploy-stage→environment map (pb.deploys). `pipelineId` is null when the pipeline
 * has no pb.pipeline-id tag (unregistered). Throws on AccessDenied so a missing IAM
 * grant surfaces loudly instead of silently dropping every event.
 */
export async function resolvePipeline(arn: string, region: string): Promise<ResolvedPipeline> {
  const cached = resolvedByArn.get(arn);
  // Serve a hit until its TTL (short for a negative, longer for a positive),
  // then re-resolve so tag changes land.
  if (cached && Date.now() - cached.ts < (cached.pipelineId !== null ? POS_CACHE_TTL_MS : NEG_CACHE_TTL_MS)) {
    return { pipelineId: cached.pipelineId, orgId: cached.orgId, deploys: cached.deploys };
  }
  try {
    const client = await pipelineClient(region);
    const { ListTagsForResourceCommand } = await loadCodePipeline();
    const out = await client.send(new ListTagsForResourceCommand({ resourceArn: arn }));
    const pipelineId = out.tags?.find(t => t.key === PIPELINE_ID_TAG)?.value ?? null;
    const orgId = out.tags?.find(t => t.key === ORG_ID_TAG)?.value ?? null;
    const deploys = parseDeploys(out.tags?.find(t => t.key === DEPLOYS_TAG)?.value);
    if (!pipelineId) log.warn('Pipeline missing pb.pipeline-id tag — skipping (register it?)', { arn });
    resolvedByArn.set(arn, { pipelineId, orgId, deploys, ts: Date.now() });
    return { pipelineId, orgId, deploys };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'AccessDeniedException') {
      // Don't cache — this is a fixable misconfig, not a property of the pipeline.
      log.error('AccessDenied calling codepipeline:ListTagsForResource — grant it to the Lambda role', { arn, error: name });
      throw err;
    }
    // Transient/infra errors (throttling, timeouts, 5xx) MUST propagate so the SQS
    // batch is retried rather than silently dropping the event — an event dropped
    // BEFORE it reaches the ingest is lost permanently (the ingest's partial-unique
    // index only dedupes events that were actually POSTed). Only swallow when the
    // failure is a definitive answer that this ARN has no usable tag.
    const e = err as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode;
    const retryable = e.$retryable != null
      || (typeof status === 'number' && status >= 500)
      || /throttl|timeout|toomanyrequests|serviceunavailable|econnreset|networkingerror/i.test(name ?? '');
    if (retryable) {
      log.error('Transient error resolving pb.pipeline-id tag — will retry the batch', { arn, error: name ?? String(err) });
      throw err;
    }
    log.error('Failed to resolve pb.pipeline-id tag', { arn, error: name ?? String(err) });
    return { pipelineId: null, orgId: null, deploys: new Map() };
  }
}

/** @internal Test-only: forget resolved pipelines. */
export function _resetTagsForTests(): void {
  resolvedByArn.clear();
}

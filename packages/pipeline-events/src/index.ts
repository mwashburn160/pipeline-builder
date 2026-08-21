// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

// AWS Lambda's Node runtime bundles @aws-sdk v3, so the CodePipeline/CodeCommit/SQS
// clients are loaded lazily via dynamic import() — a static workspace dependency on
// them would perturb the shared @aws-sdk version tree and break other packages'
// typings. The dynamic import keeps them out of the static graph while staying
// ESM-correct (no `require` in a type:module package) and mockable. Minimal local
// types keep the call sites type-checked. `@aws-sdk/client-codecommit` and
// `@aws-sdk/client-sqs` are NOT devDependencies of this package (they resolve only
// inside the Lambda runtime / jest mocks), so they are imported through a
// variable-specifier helper below so `tsc` does not try to resolve them.
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

// Variable-specifier loader for SDK clients that are NOT static devDependencies of
// this package (present only in the Lambda runtime / jest mocks). Passing the
// specifier as a `string` keeps `tsc` from resolving the module at build time.
async function loadSdk<T>(pkg: string): Promise<T> {
  return (await import(pkg)) as T;
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
 * - EVENT_DLQ_ARN — (optional) override for the dead-letter queue ARN used by the
 *   self-healing redrive; defaults to `<main-queue-arn>-dlq` derived from the SQS
 *   trigger's eventSourceARN.
 */

const log = {
  info: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'INFO', message: msg, data, ts: new Date().toISOString() })),
  warn: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'WARN', message: msg, data, ts: new Date().toISOString() })),
  error: (msg: string, data?: unknown) => console.error(JSON.stringify({ level: 'ERROR', message: msg, data, ts: new Date().toISOString() })),
};

// ── Tag resolution: pb.pipeline-id + pb.deploys ──────────
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
// pipelineId=null is a negative cache (resolved-but-untagged); `ts` lets negatives
// expire so a pipeline tagged AFTER its first event becomes resolvable without
// recycling the warm container. Positive results stay cached for the lifetime.
const resolvedByArn = new Map<string, { pipelineId: string | null; orgId: string | null; deploys: Map<string, string>; ts: number }>();
const NEG_CACHE_TTL_MS = 5 * 60 * 1000;

/** Resolved pipeline metadata read from the CodePipeline resource tags. */
interface ResolvedPipeline {
  /** Platform pipelineId (pb.pipeline-id tag); null when untagged/unregistered. */
  pipelineId: string | null;
  /** Platform orgId (OrgId tag); null when the pipeline carries no org tag. */
  orgId: string | null;
  /** Map of deploy-stage name → environment (parsed from pb.deploys). Empty when none. */
  deploys: Map<string, string>;
}

/** Cap on commit/ref/environment fields — the ingest contract allows max 255. */
const MAX_ATTR = 255;

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
async function resolvePipeline(arn: string, region: string): Promise<ResolvedPipeline> {
  const cached = resolvedByArn.get(arn);
  // Serve a positive hit for the container lifetime; serve a negative hit only
  // until it expires (then re-resolve, in case the pipeline was since tagged).
  if (cached && (cached.pipelineId !== null || Date.now() - cached.ts < NEG_CACHE_TTL_MS)) {
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
  // infra store-token writes the JWT in `password` (the canonical field — also used by
  // CodeBuild secretsManagerCredentials, the plugin-lookup Lambda, and token-renew).
  const token = secret.password;
  if (!token) {
    throw new Error('Secret missing JWT (password) — run "pipeline-manager infra store-token" to generate');
  }

  cachedToken = token;
  log.info('Using stored JWT token from Secrets Manager');
  return cachedToken;
}

// ─── Phase 4: in-account commit-range resolution ─────────
// For a source/deploy event carrying a commitSha we resolve the commit timestamp
// (and how many commits shipped) for the range since the last resolved sha of the
// same pipeline — entirely IN-ACCOUNT, per source type:
//   • CodeCommit  → AWS SDK GetCommit (walk first-parents back to the boundary).
//   • GitHub/CodeConnections-GitHub → GitHub REST compare/commits API. Authenticated
//     with the org's `pipeline-builder/{orgId}/github-token` secret when present
//     (derived from PLATFORM_SECRET_NAME), otherwise best-effort unauthenticated.
//   • Bitbucket   → Bitbucket REST commit API (single-commit; range walk omitted).
// The oldest unshipped commit's timestamp → `commitTimestamp`; the number of commits
// in the range → `commitCount`. Everything here is BEST-EFFORT: on any failure the
// fields are simply omitted (reporting falls back to `unknown`). It must NEVER fail
// the batch.
//
// IAM required by this path (document only — granted on the events stack):
//   • codecommit:GetCommit            (CodeCommit sources)
//   • secretsmanager:GetSecretValue on `pipeline-builder/*/github-token` (token SCM sources)

type SourceProvider = 'github' | 'bitbucket' | 'codecommit' | 'unknown';
interface SourceRef {
  sha: string;
  provider: SourceProvider;
  owner?: string;
  repo?: string;
  repositoryName?: string;
}
interface CommitInfo { commitTimestamp?: string; commitCount?: number }

// Per-(pipeline,sha) resolved result — computed once, reused across the many events
// (PIPELINE/STAGE/ACTION) that share a source revision and across redeliveries.
const commitResultCache = new Map<string, CommitInfo>();
// Last sha we successfully resolved per pipeline — the exclusive lower bound for the
// next range ("commits since the last deploy"). In-memory only: a cold start resets
// it, so the first post-cold event resolves as a single commit (expected, defensive).
const lastShaByPipeline = new Map<string, string>();
// Per-sha CodeCommit metadata cache (date + first-parent) for range walks.
const commitMetaCache = new Map<string, { date?: string; parents?: string[] }>();
// SCM rate-limit cooldown: after a 403/429 we stop calling the SCM for a while.
let scmCooldownUntil = 0;
const SCM_COOLDOWN_MS = 2 * 60 * 1000;
// Cap the CodeCommit first-parent walk so a long range can't blow the Lambda timeout.
const MAX_COMMIT_WALK = 50;
// Per-request timeout for external SCM calls (defensive against slow/hung hosts).
const SCM_FETCH_TIMEOUT_MS = 3000;

// The forwarder is a fleet Lambda: one warm container resolves events for MANY
// orgs, so the GitHub token MUST be keyed by the event's resolved org (not a single
// container-global token). Each org's token lives at `<prefix>/<orgId>/github-token`,
// derived from PLATFORM_SECRET_NAME (`<prefix>/<containerOrg>/platform`). null caches
// a definitive miss (no secret / read failed) → unauthenticated best-effort.
const githubTokenByOrg = new Map<string, string | null>();

/**
 * Derive a specific org's github-token secret name from PLATFORM_SECRET_NAME
 * (`<prefix>/<containerOrg>/platform`). With an `orgId` we swap the org segment
 * (`<prefix>/<orgId>/github-token`); without one (pipeline carried no OrgId tag) we
 * fall back to the container's own sibling secret. Returns undefined when
 * PLATFORM_SECRET_NAME isn't the expected `.../platform` shape.
 */
function githubTokenSecretName(orgId: string | null): string | undefined {
  const name = process.env.PLATFORM_SECRET_NAME;
  if (!name || !name.endsWith('/platform')) return undefined;
  const base = name.slice(0, -'/platform'.length); // <prefix>/<containerOrg>
  if (orgId) {
    const slash = base.lastIndexOf('/');
    const prefix = slash > 0 ? base.slice(0, slash) : base;
    return `${prefix}/${orgId}/github-token`;
  }
  return `${base}/github-token`;
}

/** Read (and cache, per org) the org github token; null → unauthenticated best-effort. */
async function getGitHubToken(orgId: string | null): Promise<string | null> {
  const key = orgId ?? '';
  const cached = githubTokenByOrg.get(key);
  if (cached !== undefined) return cached;
  const secretName = githubTokenSecretName(orgId);
  if (!secretName) { githubTokenByOrg.set(key, null); return null; }
  let token: string | null;
  try {
    const client = new SecretsManagerClient({});
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    // The github-token secret is a RAW token string (not JSON — CDK resolves it via
    // the default SecretString with no key).
    token = res.SecretString && res.SecretString.length > 0 ? res.SecretString.trim() : null;
  } catch (err) {
    log.warn('No github-token secret — GitHub commit resolution will be unauthenticated', { orgId, error: (err as { name?: string })?.name });
    token = null;
  }
  githubTokenByOrg.set(key, token);
  return token;
}

async function fetchWithTimeout(url: string, opts: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCM_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a commit date to ISO 8601. Accepts ISO strings and CodeCommit's
 *  "<epoch-seconds> +ZZZZ" form. Returns undefined when unparseable. */
function toIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const epoch = /^(\d{9,})\b/.exec(value.trim());
  if (epoch) {
    const d = new Date(Number(epoch[1]) * 1000);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Classify a source-revision URL into a provider + repo coordinates. */
function classifySource(url: string | undefined): Omit<SourceRef, 'sha'> {
  if (!url) return { provider: 'unknown' };
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return { provider: 'github', owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
    }
    if (host === 'bitbucket.org') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return { provider: 'bitbucket', owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
    }
    if (u.pathname.toLowerCase().includes('codecommit') || u.hash.toLowerCase().includes('codecommit') || u.pathname.includes('/repositories/')) {
      const m = /repositor(?:y|ies)\/([^/#?]+)/.exec(u.pathname + u.hash);
      if (m) return { provider: 'codecommit', repositoryName: decodeURIComponent(m[1]) };
    }
  } catch {
    // not a URL → unknown
  }
  return { provider: 'unknown' };
}

let codecommitClientsByRegion: Map<string, { send(command: unknown): Promise<unknown> }> | undefined;
interface CodeCommitModule {
  CodeCommitClient: new (config: { region: string }) => { send(command: unknown): Promise<unknown> };
  GetCommitCommand: new (input: { repositoryName: string; commitId: string }) => unknown;
}
let codecommitMod: CodeCommitModule | undefined;
async function codeCommitClient(region: string): Promise<{ send(command: unknown): Promise<unknown> }> {
  if (!codecommitMod) codecommitMod = await loadSdk<CodeCommitModule>('@aws-sdk/client-codecommit');
  if (!codecommitClientsByRegion) codecommitClientsByRegion = new Map();
  let client = codecommitClientsByRegion.get(region);
  if (!client) {
    client = new codecommitMod.CodeCommitClient({ region });
    codecommitClientsByRegion.set(region, client);
  }
  return client;
}

/** Fetch (cached) a single CodeCommit commit's date + first parents via GetCommit. */
async function codeCommitMeta(region: string, repositoryName: string, commitId: string): Promise<{ date?: string; parents?: string[] } | undefined> {
  const cached = commitMetaCache.get(commitId);
  if (cached) return cached;
  if (!codecommitMod) codecommitMod = await loadSdk<CodeCommitModule>('@aws-sdk/client-codecommit');
  const client = await codeCommitClient(region);
  const out = await client.send(new codecommitMod.GetCommitCommand({ repositoryName, commitId })) as {
    commit?: { committer?: { date?: string }; author?: { date?: string }; parents?: string[] };
  };
  const commit = out.commit;
  const meta = { date: toIso(commit?.committer?.date ?? commit?.author?.date), parents: commit?.parents };
  commitMetaCache.set(commitId, meta);
  return meta;
}

async function resolveCodeCommit(region: string, repositoryName: string, sha: string, sinceSha?: string): Promise<CommitInfo> {
  let cur: string | undefined = sha;
  let count = 0;
  let oldest: string | undefined;
  let truncated = false;
  for (let i = 0; ; i++) {
    if (!cur) break; // reached history root — the whole range is covered
    if (sinceSha && cur === sinceSha) break; // reached the exclusive lower bound
    if (i >= MAX_COMMIT_WALK) { truncated = true; break; } // hit the cap before the boundary
    const meta = await codeCommitMeta(region, repositoryName, cur);
    if (!meta?.date) break;
    count++;
    oldest = meta.date;
    if (!sinceSha) break; // no range → single commit
    cur = meta.parents?.[0];
  }
  // A truncated walk yields a commit NEWER than the true oldest-unshipped commit,
  // which would UNDERSTATE lead time — omit the fields entirely rather than report a
  // wrong (too-small) value. Reporting falls back to `unknown`.
  if (truncated) return {};
  return oldest ? { commitTimestamp: oldest, commitCount: count } : {};
}

async function resolveGitHub(owner: string, repo: string, sha: string, sinceSha: string | undefined, orgId: string | null): Promise<CommitInfo> {
  const token = await getGitHubToken(orgId);
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'pipeline-builder-forwarder',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const rateLimited = (r: Response) => r.status === 403 || r.status === 429;

  if (sinceSha) {
    const r = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}/compare/${sinceSha}...${sha}`, { headers });
    if (rateLimited(r)) { scmCooldownUntil = Date.now() + SCM_COOLDOWN_MS; return {}; }
    if (r.ok) {
      const j = await r.json() as { commits?: Array<{ commit?: { committer?: { date?: string }; author?: { date?: string } } }> };
      const commits = Array.isArray(j.commits) ? j.commits : [];
      if (commits.length > 0) {
        const oldest = toIso(commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date);
        if (oldest) return { commitTimestamp: oldest, commitCount: commits.length };
      }
    }
    // fall through to single-commit resolution
  }
  const r2 = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, { headers });
  if (rateLimited(r2)) { scmCooldownUntil = Date.now() + SCM_COOLDOWN_MS; return {}; }
  if (r2.ok) {
    const j = await r2.json() as { commit?: { committer?: { date?: string }; author?: { date?: string } } };
    const d = toIso(j.commit?.committer?.date ?? j.commit?.author?.date);
    if (d) return { commitTimestamp: d, commitCount: 1 };
  }
  return {};
}

async function resolveBitbucket(owner: string, repo: string, sha: string): Promise<CommitInfo> {
  const r = await fetchWithTimeout(`https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/commit/${sha}`, {
    headers: { 'User-Agent': 'pipeline-builder-forwarder', 'Accept': 'application/json' },
  });
  if (r.status === 429) { scmCooldownUntil = Date.now() + SCM_COOLDOWN_MS; return {}; }
  if (r.ok) {
    const j = await r.json() as { date?: string };
    const d = toIso(j.date);
    if (d) return { commitTimestamp: d, commitCount: 1 };
  }
  return {};
}

/**
 * Resolve `commitTimestamp` + `commitCount` for a source/deploy event, in-account,
 * best-effort. Computed once per (pipelineId, sha); advances the pipeline's range
 * boundary only on success. Never throws — returns {} on any failure.
 */
async function resolveCommitInfo(pipelineId: string, orgId: string | null, region: string, src: SourceRef): Promise<CommitInfo> {
  if (src.provider === 'unknown') return {};
  const rkey = `${pipelineId}|${src.sha}`;
  const cached = commitResultCache.get(rkey);
  if (cached) return cached;

  const prev = lastShaByPipeline.get(pipelineId);
  const sinceSha = prev && prev !== src.sha ? prev : undefined;

  let info: CommitInfo = {};
  try {
    if (src.provider === 'codecommit' && src.repositoryName) {
      info = await resolveCodeCommit(region, src.repositoryName, src.sha, sinceSha);
    } else if (src.provider === 'github' && src.owner && src.repo) {
      if (Date.now() >= scmCooldownUntil) info = await resolveGitHub(src.owner, src.repo, src.sha, sinceSha, orgId);
    } else if (src.provider === 'bitbucket' && src.owner && src.repo) {
      if (Date.now() >= scmCooldownUntil) info = await resolveBitbucket(src.owner, src.repo, src.sha);
    }
  } catch (err) {
    log.warn('Commit resolution failed (omitting commitTimestamp/commitCount)', { provider: src.provider, error: (err as { name?: string })?.name ?? String(err) });
    info = {};
  }

  commitResultCache.set(rkey, info);
  if (info.commitTimestamp) lastShaByPipeline.set(pipelineId, src.sha);
  return info;
}

// ─── Event Parsing ──────────────────────────────────────

interface ParsedEvent {
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
   *  deploy — resolved in-account (Phase 4). Undefined when unresolvable. */
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

  // Phase 4 — resolve the commit range (oldest-unshipped timestamp + count) for any
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

// ─── Phase 3: delivery health + self-healing DLQ redrive ─
// After a SUCCESSFUL batch POST we (throttled, best-effort):
//   1. POST an ingest-health signal to /api/reports/ingest-health so the Reports UI
//      can show flowing / stale / dropping.
//   2. If the DLQ is non-empty, no move task is already running, AND the oldest DLQ
//      message is younger than the poison-age ceiling, kick off an SQS
//      MessageMoveTask (DLQ → main queue) so retryable failures self-heal without a
//      new AWS service. The reporting ingest's partial-unique index dedupes any
//      redelivered event, so a redrive can't double-count.
// Guards: only on success, one-at-a-time (ListMessageMoveTasks), a poison-age ceiling
// (so a message that always fails can't loop DLQ→main→DLQ forever), and throttled via
// module timestamps. NEVER throws — a failure here must not fail the batch.
//
// IAM required (document only — granted on the events stack):
//   sqs:GetQueueAttributes, sqs:ListMessageMoveTasks, sqs:StartMessageMoveTask (on the DLQ)

interface SqsClientLike { send(command: unknown): Promise<unknown> }
interface SqsModule {
  SQSClient: new (config: { region: string }) => SqsClientLike;
  GetQueueAttributesCommand: new (input: { QueueUrl: string; AttributeNames: string[] }) => unknown;
  ListMessageMoveTasksCommand: new (input: { SourceArn: string }) => unknown;
  StartMessageMoveTaskCommand: new (input: { SourceArn: string; DestinationArn?: string }) => unknown;
}
let sqsMod: SqsModule | undefined;
let sqsClientsByRegion: Map<string, SqsClientLike> | undefined;
async function sqsClient(region: string): Promise<SqsClientLike> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  if (!sqsClientsByRegion) sqsClientsByRegion = new Map();
  let client = sqsClientsByRegion.get(region);
  if (!client) {
    client = new sqsMod.SQSClient({ region });
    sqsClientsByRegion.set(region, client);
  }
  return client;
}

// Delivery-health counters are attributed PER RESOLVED ORG (the forwarder is a fleet
// Lambda serving many orgs; a single global counter would mis-attribute one org's
// throughput to another). Keyed by orgId ('' bucket = pipeline with no OrgId tag).
// The DLQ depth (`dropped`) is genuinely fleet-global — one shared DLQ — so it is a
// single snapshot posted alongside each org's health, documented as the shared depth.
const forwardedByOrg = new Map<string, number>();
const lastEventAtByOrg = new Map<string, string>();
let lastHealthAt = 0;
let lastRedriveAt = 0;
const HEALTH_THROTTLE_MS = 60 * 1000;
const REDRIVE_THROTTLE_MS = 5 * 60 * 1000;
// Poison-message ceiling: if the oldest DLQ message is older than this, we STOP
// redriving it (DLQ→main→fail→DLQ would loop forever). Such messages are left for an
// alarm / manual inspection instead of churning the fleet indefinitely.
const MAX_DLQ_REDRIVE_AGE_SEC = 6 * 60 * 60; // 6 hours

/** Parse the SQS trigger ARN and derive the main + DLQ ARNs and the DLQ URL. */
function deriveQueues(mainQueueArn: string | undefined): { region: string; mainArn: string; dlqArn: string; dlqUrl: string } | undefined {
  if (!mainQueueArn) return undefined;
  // arn:aws:sqs:{region}:{account}:{name}
  const parts = mainQueueArn.split(':');
  if (parts.length < 6 || parts[2] !== 'sqs') return undefined;
  const [, , , region, account, name] = parts;
  const dlqArn = process.env.EVENT_DLQ_ARN || `arn:aws:sqs:${region}:${account}:${name}-dlq`;
  const dlqName = dlqArn.split(':').pop() ?? `${name}-dlq`;
  const dlqUrl = `https://sqs.${region}.amazonaws.com/${account}/${dlqName}`;
  return { region, mainArn: mainQueueArn, dlqArn, dlqUrl };
}

/** Snapshot the DLQ depth + the age (seconds) of its oldest message (for the
 *  poison-message redrive ceiling). Missing/NaN attributes fall back to 0. */
async function dlqStats(region: string, dlqUrl: string): Promise<{ depth: number; oldestAgeSec: number }> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  const client = await sqsClient(region);
  const out = await client.send(new sqsMod.GetQueueAttributesCommand({
    QueueUrl: dlqUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateAgeOfOldestMessage'],
  })) as { Attributes?: { ApproximateNumberOfMessages?: string; ApproximateAgeOfOldestMessage?: string } };
  const n = Number(out.Attributes?.ApproximateNumberOfMessages ?? '0');
  const age = Number(out.Attributes?.ApproximateAgeOfOldestMessage ?? '0');
  return {
    depth: Number.isFinite(n) ? n : 0,
    oldestAgeSec: Number.isFinite(age) ? age : 0,
  };
}

async function hasActiveMoveTask(region: string, dlqArn: string): Promise<boolean> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  const client = await sqsClient(region);
  const out = await client.send(new sqsMod.ListMessageMoveTasksCommand({ SourceArn: dlqArn })) as {
    Results?: Array<{ Status?: string }>;
  };
  return (out.Results ?? []).some(t => t.Status === 'RUNNING');
}

async function startMoveTask(region: string, dlqArn: string, mainArn: string): Promise<void> {
  if (!sqsMod) sqsMod = await loadSdk<SqsModule>('@aws-sdk/client-sqs');
  const client = await sqsClient(region);
  await client.send(new sqsMod.StartMessageMoveTaskCommand({ SourceArn: dlqArn, DestinationArn: mainArn }));
}

/** POST one org's ingest-health signal. Returns true only on a confirmed 2xx so the
 *  caller resets that org's `forwarded` counter ONLY when the signal was accepted
 *  (a dropped/failed POST must not silently zero the accumulated count). */
async function postIngestHealth(baseUrl: string, body: { orgId?: string; forwarded: number; dropped: number; lastEventAt?: string }): Promise<boolean> {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${baseUrl}/api/reports/ingest-health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn('ingest-health POST returned non-2xx (ignored)', { status: res.status, orgId: body.orgId });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('ingest-health POST failed (ignored)', { error: String(err), orgId: body.orgId });
    return false;
  }
}

/**
 * Throttled, best-effort post-success work: emit per-org ingest-health and self-heal
 * the DLQ. Never throws. `forwarded`/`lastEventAt` accumulate PER ORG across batches
 * between health posts; `dropped` is the shared fleet DLQ depth snapshot. A per-org
 * counter is zeroed only after that org's health POST is confirmed 2xx.
 */
async function reportHealthAndRedrive(baseUrl: string, mainQueueArn: string | undefined): Promise<void> {
  const now = Date.now();
  if (now - lastHealthAt < HEALTH_THROTTLE_MS) return;
  lastHealthAt = now;
  try {
    const q = deriveQueues(mainQueueArn);
    let depth = 0;
    let oldestAgeSec = 0;
    if (q) {
      try {
        const stats = await dlqStats(q.region, q.dlqUrl);
        depth = stats.depth;
        oldestAgeSec = stats.oldestAgeSec;
      } catch (err) {
        log.warn('DLQ stats check failed (ignored)', { error: (err as { name?: string })?.name ?? String(err) });
      }
    }

    // Post one health signal per resolved org, attributing its own forwarded count +
    // last event time. `dropped` (the shared fleet DLQ depth) rides along on each.
    // Snapshot the keys first so we don't mutate the map while iterating.
    const orgKeys = new Set([...forwardedByOrg.keys(), ...lastEventAtByOrg.keys()]);
    if (orgKeys.size === 0) orgKeys.add(''); // nothing forwarded yet → still report depth
    for (const key of orgKeys) {
      const forwarded = forwardedByOrg.get(key) ?? 0;
      const lastEventAt = lastEventAtByOrg.get(key);
      const ok = await postIngestHealth(baseUrl, {
        ...(key ? { orgId: key } : {}),
        forwarded,
        dropped: depth,
        lastEventAt,
      });
      // Reset the forwarded counter ONLY on a confirmed 2xx — a failed/dropped POST
      // keeps the count so the next tick re-reports it instead of losing it.
      if (ok) forwardedByOrg.set(key, 0);
    }

    if (q && depth > 0 && now - lastRedriveAt >= REDRIVE_THROTTLE_MS) {
      // Poison-message ceiling: never redrive a DLQ whose oldest message has aged
      // past the ceiling — that message keeps failing and would loop DLQ→main→DLQ.
      if (oldestAgeSec > MAX_DLQ_REDRIVE_AGE_SEC) {
        log.warn('DLQ oldest message exceeds poison-age ceiling — skipping redrive (needs manual attention)', {
          dlqArn: q.dlqArn, dropped: depth, oldestAgeSec, ceilingSec: MAX_DLQ_REDRIVE_AGE_SEC,
        });
      } else {
        try {
          if (!(await hasActiveMoveTask(q.region, q.dlqArn))) {
            lastRedriveAt = now;
            await startMoveTask(q.region, q.dlqArn, q.mainArn);
            log.info('Started self-healing DLQ→main redrive', { dlqArn: q.dlqArn, dropped: depth, oldestAgeSec });
          }
        } catch (err) {
          log.warn('DLQ redrive failed (ignored)', { error: (err as { name?: string })?.name ?? String(err) });
        }
      }
    }
  } catch (err) {
    log.warn('health/redrive step failed (ignored)', { error: String(err) });
  }
}

// ─── Handler ────────────────────────────────────────────

export const handler = async (event: SQSEvent): Promise<void> => {
  const baseUrl = process.env.PLATFORM_BASE_URL;
  if (!baseUrl) throw new Error('PLATFORM_BASE_URL environment variable is required');

  // Parse + resolve all records (tag + commit lookups run concurrently); drop
  // intentional skips (null). A malformed record BODY is handled inside parseRecord
  // (logged + skipped) so one bad message can't fail the whole batch — while genuine
  // infra errors (e.g. AccessDenied on the tag lookup) still propagate so a missing
  // IAM grant surfaces and SQS retries the batch.
  const events = (await Promise.all(event.Records.map(parseRecord)))
    .filter((e): e is ParsedEvent => e !== null);
  if (events.length === 0) {
    log.info('No resolvable CodePipeline events in batch');
    return;
  }

  // POST batch to reporting service. On a 401/403 the cached JWT has likely
  // expired — drop it, re-fetch, and retry ONCE so an expired token doesn't
  // permanently brick a warm container. `orgId` is INTERNAL (token/health keying) —
  // strip it here so it never rides the wire; the ingest resolves org from the
  // pipeline registry, not the body.
  const payloadEvents = events.map(({ orgId: _orgId, ...rest }) => rest);
  const post = (token: string) => fetch(`${baseUrl}/api/reports/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ events: payloadEvents }),
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

  // The insert already succeeded (2xx). The parsed body is only used for a log
  // line, so a non-JSON/empty body must not throw and fail the whole batch —
  // that would trigger an SQS redelivery and re-POST (duplicate) already-inserted
  // events. The ingest's partial-unique index dedupes, but avoid the churn anyway.
  const result = await res.json().catch(() => ({})) as Record<string, unknown>;
  log.info(`Ingested ${events.length} events`, { inserted: result.data });

  // Accumulate delivery-health counters PER RESOLVED ORG, then run the throttled
  // post-success health + self-healing DLQ redrive (best-effort, never fails batch).
  for (const e of events) {
    const key = e.orgId ?? '';
    forwardedByOrg.set(key, (forwardedByOrg.get(key) ?? 0) + 1);
    const at = e.completedAt || e.startedAt;
    if (at) {
      const prev = lastEventAtByOrg.get(key);
      if (!prev || at > prev) lastEventAtByOrg.set(key, at);
    }
  }
  await reportHealthAndRedrive(baseUrl, event.Records[0]?.eventSourceARN);
};

/**
 * @internal Test-only: reset all module-level caches/throttle state so tests are
 * isolated from one another. Stripped from the published .d.ts (stripInternal).
 */
export function _resetForTests(): void {
  resolvedByArn.clear();
  commitResultCache.clear();
  lastShaByPipeline.clear();
  commitMetaCache.clear();
  scmCooldownUntil = 0;
  githubTokenByOrg.clear();
  forwardedByOrg.clear();
  lastEventAtByOrg.clear();
  lastHealthAt = 0;
  lastRedriveAt = 0;
  cachedToken = null;
}

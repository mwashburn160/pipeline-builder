// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { BoundedMap, CACHE_MAX_ENTRIES, loadSdk, log } from './util.js';

// In-account commit-range resolution.
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
export interface SourceRef {
  sha: string;
  provider: SourceProvider;
  owner?: string;
  repo?: string;
  repositoryName?: string;
}
export interface CommitInfo { commitTimestamp?: string; commitCount?: number }

// Per-(pipeline,sha) resolved result — computed once, reused across the many events
// (PIPELINE/STAGE/ACTION) that share a source revision and across redeliveries.
// Only RESOLVED results are cached — an empty `{}` (SCM cooldown, a timeout, a
// 404 from a repo whose token was just added) must not pin "no commit info" for
// that sha for the container's lifetime.
const commitResultCache = new BoundedMap<string, CommitInfo>(CACHE_MAX_ENTRIES);
// Last sha we successfully resolved per pipeline — the exclusive lower bound for the
// next range ("commits since the last deploy"). In-memory only: a cold start resets
// it, so the first post-cold event resolves as a single commit (expected, defensive).
const lastShaByPipeline = new BoundedMap<string, string>(CACHE_MAX_ENTRIES);
// Per-sha CodeCommit metadata cache (date + first-parent) for range walks.
const commitMetaCache = new BoundedMap<string, { date?: string; parents?: string[] }>(CACHE_MAX_ENTRIES);
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
const githubTokenByOrg = new BoundedMap<string, string | null>(CACHE_MAX_ENTRIES);

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
export function classifySource(url: string | undefined): Omit<SourceRef, 'sha'> {
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
export async function resolveCommitInfo(pipelineId: string, orgId: string | null, region: string, src: SourceRef): Promise<CommitInfo> {
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

  if (info.commitTimestamp) {
    commitResultCache.set(rkey, info);
    lastShaByPipeline.set(pipelineId, src.sha);
  }
  return info;
}

/** @internal Test-only: forget resolved commits, SCM cooldown and cached tokens. */
export function _resetScmForTests(): void {
  commitResultCache.clear();
  lastShaByPipeline.clear();
  commitMetaCache.clear();
  scmCooldownUntil = 0;
  githubTokenByOrg.clear();
}

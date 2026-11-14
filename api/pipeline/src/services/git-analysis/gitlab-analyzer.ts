// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { buildAnalysis } from './analysis-core.js';
import type { ParsedGitUrl, RepoAnalysis } from './analysis-core.js';
import { fetchWithTimeout } from './http.js';

const GITLAB_API_BASE_URL = CoreConstants.GITLAB_API_BASE_URL;

/**
 * Analyze a GitLab repository via the GitLab REST API.
 *
 * @param parsed - Parsed Git URL with owner/repo
 * @param token - Optional GitLab personal access token for private repos
 * @returns Repository analysis
 */
export async function analyzeGitLabRepo(parsed: ParsedGitUrl, token?: string): Promise<RepoAnalysis> {
  const headers: Record<string, string> = {};
  if (token) headers['PRIVATE-TOKEN'] = token;

  // `encodeURIComponent` over `owner/repo` is GitLab's own project-id encoding
  // and also stops a crafted segment path-traversing within the API host.
  const projectId = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
  // PINNED, never `parsed.host`: the host arrives in a request body. It was
  // interpolated from the parsed URL, which was safe only by the accident that
  // `GIT_PROVIDERS` (providerForHost) reaches this analyzer for `gitlab.com` alone — one new
  // self-hosted-GitLab branch in `parseGitUrl` and it became a request to an
  // attacker-chosen host from inside the cluster.
  const baseUrl = GITLAB_API_BASE_URL;

  const [repoRes, langRes, treeRes] = await Promise.all([
    fetchWithTimeout(`${baseUrl}/projects/${projectId}`, { headers }),
    fetchWithTimeout(`${baseUrl}/projects/${projectId}/languages`, { headers }),
    fetchWithTimeout(`${baseUrl}/projects/${projectId}/repository/tree?per_page=100`, { headers }),
  ]);

  if (!repoRes.ok) {
    throw new Error(`GitLab API error: ${repoRes.status} ${repoRes.statusText}`);
  }

  const repoData = repoRes.json<Record<string, unknown>>();
  const languages = langRes.ok ? langRes.json<Record<string, number>>() : {};
  const tree = treeRes.ok
    ? treeRes.json<Array<{ name: string; type: string }>>()
    : [];

  const detectedFiles = tree
    .filter((t) => t.type === 'blob' || t.type === 'tree')
    .map((t) => t.name);

  return buildAnalysis(parsed, {
    defaultBranch: (repoData.default_branch as string) || 'main',
    description: (repoData.description as string) || '',
    topics: (repoData.topics as string[]) || [],
    languages,
    detectedFiles,
  });
}

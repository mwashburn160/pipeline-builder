// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildAnalysis } from './analysis-core.js';
import type { ParsedGitUrl, RepoAnalysis } from './analysis-core.js';
import { fetchWithTimeout } from './http.js';

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

  const projectId = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
  const baseUrl = `https://${parsed.host}/api/v4`;

  const [repoRes, langRes, treeRes] = await Promise.all([
    fetchWithTimeout(`${baseUrl}/projects/${projectId}`, { headers }),
    fetchWithTimeout(`${baseUrl}/projects/${projectId}/languages`, { headers }),
    fetchWithTimeout(`${baseUrl}/projects/${projectId}/repository/tree?per_page=100`, { headers }),
  ]);

  if (!repoRes.ok) {
    throw new Error(`GitLab API error: ${repoRes.status} ${repoRes.statusText}`);
  }

  const repoData = await repoRes.json() as Record<string, unknown>;
  const languages = langRes.ok ? (await langRes.json() as Record<string, number>) : {};
  const tree = treeRes.ok
    ? (await treeRes.json() as Array<{ name: string; type: string }>)
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

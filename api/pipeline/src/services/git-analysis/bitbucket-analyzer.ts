// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { buildAnalysis } from './analysis-core.js';
import type { ParsedGitUrl, RepoAnalysis } from './analysis-core.js';
import { fetchWithTimeout, readJsonCapped } from './http.js';

const BITBUCKET_API_BASE_URL = CoreConstants.BITBUCKET_API_BASE_URL;

/**
 * Analyze a Bitbucket repository via the Bitbucket REST API.
 *
 * @param parsed - Parsed Git URL with owner/repo
 * @param token - Optional Bitbucket app password for private repos
 * @returns Repository analysis
 */
export async function analyzeBitbucketRepo(parsed: ParsedGitUrl, token?: string): Promise<RepoAnalysis> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const baseUrl = BITBUCKET_API_BASE_URL;

  // Encode each path segment so owner/repo values (which for SSH URLs may embed
  // `..`/`/`) can't path-traverse within api.bitbucket.org.
  const owner = encodeURIComponent(parsed.owner);
  const repo = encodeURIComponent(parsed.repo);

  const [repoRes, srcRes] = await Promise.all([
    fetchWithTimeout(`${baseUrl}/repositories/${owner}/${repo}`, { headers }),
    fetchWithTimeout(`${baseUrl}/repositories/${owner}/${repo}/src/?pagelen=100`, { headers }),
  ]);

  if (!repoRes.ok) {
    throw new Error(`Bitbucket API error: ${repoRes.status} ${repoRes.statusText}`);
  }

  const repoData = await readJsonCapped<Record<string, unknown>>(repoRes);
  const mainBranch = repoData.mainbranch as Record<string, unknown> | undefined;
  const language = repoData.language as string | undefined;

  const srcData = srcRes.ok
    ? await readJsonCapped<{ values?: Array<{ path: string; type: string }> }>(srcRes)
    : { values: [] };
  const detectedFiles = (srcData.values || [])
    .filter((s) => s.type === 'commit_file' || s.type === 'commit_directory')
    .map((s) => s.path);

  // Bitbucket doesn't have a languages endpoint like GitHub — use the top-level language field
  const languages: Record<string, number> = {};
  if (language) languages[language] = 100;

  return buildAnalysis(parsed, {
    defaultBranch: (mainBranch?.name as string) || 'main',
    description: (repoData.description as string) || '',
    topics: [],
    languages,
    detectedFiles,
  });
}

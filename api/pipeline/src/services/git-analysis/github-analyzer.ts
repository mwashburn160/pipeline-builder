// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { buildAnalysis } from './analysis-core.js';
import type { ParsedGitUrl, RepoAnalysis } from './analysis-core.js';
import { fetchWithTimeout } from './http.js';

const GITHUB_API_BASE_URL = CoreConstants.GITHUB_API_BASE_URL;

/**
 * Analyze a GitHub repository via the GitHub REST API.
 *
 * @param parsed - Parsed Git URL with owner/repo
 * @param token - Optional GitHub personal access token for private repos
 * @returns Repository analysis
 */
export async function analyzeGitHubRepo(parsed: ParsedGitUrl, token?: string): Promise<RepoAnalysis> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'pipeline-builder',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const baseUrl = GITHUB_API_BASE_URL;

  // Fetch repo metadata + languages + root contents in parallel
  const [repoRes, langRes, contentsRes] = await Promise.all([
    fetchWithTimeout(`${baseUrl}/repos/${parsed.owner}/${parsed.repo}`, { headers }),
    fetchWithTimeout(`${baseUrl}/repos/${parsed.owner}/${parsed.repo}/languages`, { headers }),
    fetchWithTimeout(`${baseUrl}/repos/${parsed.owner}/${parsed.repo}/contents/`, { headers }),
  ]);

  if (!repoRes.ok) {
    throw new Error(`GitHub API error: ${repoRes.status} ${repoRes.statusText}`);
  }

  const repoData = await repoRes.json() as Record<string, unknown>;
  const languages = langRes.ok ? (await langRes.json() as Record<string, number>) : {};
  const contents = contentsRes.ok
    ? (await contentsRes.json() as Array<{ name: string; type: string }>)
    : [];

  const detectedFiles = contents
    .filter((c) => c.type === 'file' || c.type === 'dir')
    .map((c) => c.name);

  return buildAnalysis(parsed, {
    defaultBranch: (repoData.default_branch as string) || 'main',
    description: (repoData.description as string) || '',
    topics: (repoData.topics as string[]) || [],
    languages,
    detectedFiles,
  });
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import type { GitProvider, ParsedGitUrl, RepoAnalysis } from './git-analysis/analysis-core.js';
import { analyzeBitbucketRepo } from './git-analysis/bitbucket-analyzer.js';
import { analyzeGitHubRepo } from './git-analysis/github-analyzer.js';
import { analyzeGitLabRepo } from './git-analysis/gitlab-analyzer.js';

// Re-export shared types and inference helpers so the public import path
// (`git-analysis-service`) is preserved after the provider analyzers were
// split into per-provider modules under `git-analysis/`.
export type { GitProvider, ParsedGitUrl, RepoAnalysis } from './git-analysis/analysis-core.js';
export { inferProjectType, inferPackageManager, inferFrameworks } from './git-analysis/analysis-core.js';

const logger = createLogger('git-analysis');

// URL Parsing

/** Hostname-to-provider mapping. */
const HOST_PROVIDER_MAP: Record<string, GitProvider> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
};

/**
 * Parse a Git URL into its component parts.
 *
 * Supports:
 * - HTTPS: `https://github.com/owner/repo`, `https://gitlab.com/group/repo.git`
 * - SSH: `git@github.com:owner/repo.git`, `git@gitlab.com:group/repo.git`
 * - SSH with protocol: `ssh://git@github.com/owner/repo.git`
 * - With tree paths: `https://github.com/owner/repo/tree/main/src`
 * - Self-hosted: `https://git.company.com/team/project`
 *
 * @param url - Git URL string to parse
 * @returns Parsed URL components, or `null` if the URL is invalid
 */
export function parseGitUrl(url: string): ParsedGitUrl | null {
  if (!url || typeof url !== 'string') return null;

  const trimmed = url.trim();
  if (!trimmed) return null;

  // SSH format: git@host:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    const segments = path.split('/');
    if (segments.length < 2) return null;
    const repo = segments.pop()!;
    const owner = segments.join('/');
    return {
      host,
      owner,
      repo,
      provider: HOST_PROVIDER_MAP[host] ?? 'unknown',
    };
  }

  // SSH with protocol: ssh://git@host/owner/repo.git
  const sshProtoMatch = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshProtoMatch) {
    const [, host, path] = sshProtoMatch;
    const segments = path.split('/');
    if (segments.length < 2) return null;
    const repo = segments.pop()!;
    const owner = segments.join('/');
    return {
      host,
      owner,
      repo,
      provider: HOST_PROVIDER_MAP[host] ?? 'unknown',
    };
  }

  // HTTPS format
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname;
    // Remove leading slash, strip .git suffix
    let path = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');

    // Strip tree/branch/subpath (e.g. /tree/main/src → remove /tree/... onward)
    const treeIdx = path.indexOf('/tree/');
    if (treeIdx !== -1) {
      path = path.substring(0, treeIdx);
    }
    // Strip blob/branch/subpath
    const blobIdx = path.indexOf('/blob/');
    if (blobIdx !== -1) {
      path = path.substring(0, blobIdx);
    }

    const segments = path.split('/').filter(Boolean);
    if (segments.length < 2) return null;

    const repo = segments.pop()!;
    const owner = segments.join('/');

    return {
      host,
      owner,
      repo,
      provider: HOST_PROVIDER_MAP[host] ?? 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Perform a minimal analysis for unknown Git providers (no API calls).
 *
 * @param parsed - Parsed Git URL
 * @returns Minimal repository analysis
 */
function analyzeUnknownRepo(parsed: ParsedGitUrl): RepoAnalysis {
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    host: parsed.host,
    provider: parsed.provider,
    defaultBranch: 'main',
    description: '',
    topics: [],
    languages: {},
    detectedFiles: [],
    projectType: 'unknown',
    hasDockerfile: false,
    hasCdkJson: false,
    packageManager: 'unknown',
    frameworks: [],
  };
}

// Main Entry Point

/**
 * Analyze a repository by dispatching to the appropriate provider analyzer.
 *
 * @param parsed - Parsed Git URL
 * @param token - Optional authentication token for private repos
 * @returns Repository analysis
 */
export async function analyzeRepository(parsed: ParsedGitUrl, token?: string): Promise<RepoAnalysis> {
  logger.info('Analyzing repository', { host: parsed.host, owner: parsed.owner, repo: parsed.repo, provider: parsed.provider });

  /** Provider-to-analyzer dispatch map. */
  const analyzers: Record<GitProvider, (p: ParsedGitUrl, t?: string) => Promise<RepoAnalysis>> = {
    github: analyzeGitHubRepo,
    gitlab: analyzeGitLabRepo,
    bitbucket: analyzeBitbucketRepo,
    unknown: (p) => Promise.resolve(analyzeUnknownRepo(p)),
  };

  return (analyzers[parsed.provider] ?? analyzers.unknown)(parsed, token);
}

// Enhanced Prompt Builder

/**
 * Build an enhanced AI prompt from repository analysis results.
 *
 * The prompt includes detected project type, languages, frameworks,
 * package manager, and source configuration guidance so the AI can
 * generate an accurate pipeline configuration.
 *
 * @param analysis - Repository analysis
 * @returns Enhanced prompt string
 */
export function buildEnhancedPrompt(analysis: RepoAnalysis): string {
  const lines: string[] = [];

  lines.push(`Generate a CI/CD pipeline configuration for the repository "${analysis.owner}/${analysis.repo}".`);
  lines.push('');

  if (analysis.description) {
    lines.push(`Repository description: ${analysis.description}`);
  }

  lines.push(`Project type: ${analysis.projectType}`);

  if (Object.keys(analysis.languages).length > 0) {
    const sorted = Object.entries(analysis.languages).sort(([, a], [, b]) => b - a);
    lines.push(`Languages: ${sorted.map(([lang, pct]) => `${lang} (${pct}%)`).join(', ')}`);
  }

  if (analysis.frameworks.length > 0) {
    lines.push(`Frameworks: ${analysis.frameworks.join(', ')}`);
  }

  if (analysis.packageManager !== 'unknown') {
    lines.push(`Package manager: ${analysis.packageManager}`);
  }

  if (analysis.hasDockerfile) {
    lines.push('The repository contains a Dockerfile.');
  }

  if (analysis.hasCdkJson) {
    lines.push('The repository contains cdk.json (AWS CDK project).');
  }

  if (analysis.topics.length > 0) {
    lines.push(`Topics: ${analysis.topics.join(', ')}`);
  }

  // Repository-aware plugin recommendations based on detected files
  const recommendations: string[] = [];
  const files = new Set(analysis.detectedFiles.map(f => f.toLowerCase()));

  if (files.has('.github/workflows') || analysis.detectedFiles.some(f => f.includes('.github/workflows'))) {
    recommendations.push('Repository has GitHub Actions — consider migrating CI/CD steps to equivalent plugins.');
  }
  if (files.has('jenkinsfile')) {
    recommendations.push('Repository has Jenkinsfile — map Jenkins stages to pipeline stages.');
  }
  if (files.has('buildspec.yml') || files.has('buildspec.yaml')) {
    recommendations.push('Repository has buildspec.yml — use commands from it as reference for build steps.');
  }
  if (analysis.hasDockerfile) {
    recommendations.push('Repository has Dockerfile — include a docker-build plugin in the pipeline and enable Docker in synth.');
  }
  if (analysis.hasCdkJson) {
    recommendations.push('Repository is a CDK project — use cdk-synth for synthesis and cdk-deploy for deployment.');
  }
  if (files.has('jest.config.js') || files.has('jest.config.ts') || files.has('vitest.config.ts')) {
    recommendations.push('Repository has test config — add a testing stage with jest or appropriate test plugin.');
  }
  if (files.has('.eslintrc.js') || files.has('.eslintrc.json') || files.has('eslint.config.js')) {
    recommendations.push('Repository has ESLint config — add an eslint quality check stage.');
  }
  if (files.has('sonar-project.properties')) {
    recommendations.push('Repository has SonarQube config — add sonarcloud security scanning stage.');
  }
  if (files.has('cypress.config.js') || files.has('cypress.config.ts')) {
    recommendations.push('Repository has Cypress config — add cypress E2E testing stage.');
  }
  if (files.has('playwright.config.ts') || files.has('playwright.config.js')) {
    recommendations.push('Repository has Playwright config — add playwright testing stage.');
  }

  if (recommendations.length > 0) {
    lines.push('');
    lines.push('## Detected CI/CD hints:');
    for (const rec of recommendations) lines.push(`- ${rec}`);
  }

  // Source configuration guidance
  lines.push('');
  if (analysis.provider === 'github') {
    lines.push(`Source configuration: Use type "github" with repo "${analysis.owner}/${analysis.repo}" and branch "${analysis.defaultBranch}".`);
  } else {
    lines.push(`Source configuration: Use type "codestar" with repo "${analysis.owner}/${analysis.repo}" and branch "${analysis.defaultBranch}". The connectionArn will be set later.`);
  }

  lines.push('');
  lines.push('Use the project name as the pipeline project identifier. Choose appropriate build plugins based on the project type, languages, and detected CI/CD hints above.');

  return lines.join('\n');
}

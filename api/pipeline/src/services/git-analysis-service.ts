// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';

const logger = createLogger('git-analysis');

const GITHUB_API_BASE_URL = CoreConstants.GITHUB_API_BASE_URL;
const BITBUCKET_API_BASE_URL = CoreConstants.BITBUCKET_API_BASE_URL;

// Types

/** Supported Git hosting providers. */
export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'unknown';

/** Result of parsing a Git URL. */
export interface ParsedGitUrl {
  /** Hostname (e.g. "github.com", "gitlab.com", "git.company.com"). */
  host: string;
  /** Repository owner or group (e.g. "facebook", "mygroup/subgroup"). */
  owner: string;
  /** Repository name without .git suffix. */
  repo: string;
  /** Detected Git hosting provider. */
  provider: GitProvider;
}

/** Aggregated repository analysis result. */
export interface RepoAnalysis {
  /** Repository owner. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Git host. */
  host: string;
  /** Detected Git provider. */
  provider: GitProvider;
  /** Default branch name (e.g. "main", "master"). */
  defaultBranch: string;
  /** Repository description. */
  description: string;
  /** Repository topics/tags. */
  topics: string[];
  /** Languages detected (e.g. { "TypeScript": 60, "JavaScript": 30 }). */
  languages: Record<string, number>;
  /** Notable files found in the repository root. */
  detectedFiles: string[];
  /** Inferred project type (e.g. "nodejs", "python", "go"). */
  projectType: string;
  /** Whether a Dockerfile exists. */
  hasDockerfile: boolean;
  /** Whether cdk.json exists. */
  hasCdkJson: boolean;
  /** Detected package manager. */
  packageManager: string;
  /** Detected frameworks (e.g. ["Next.js", "React"]). */
  frameworks: string[];
}

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

// Project Type Inference

/** Map of filenames to project type indicators. */
const PROJECT_TYPE_FILES: Record<string, string> = {
  'package.json': 'nodejs',
  'requirements.txt': 'python',
  'setup.py': 'python',
  'pyproject.toml': 'python',
  'Pipfile': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'rust',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'kotlin',
  'Gemfile': 'ruby',
  'composer.json': 'php',
  'mix.exs': 'elixir',
  'pubspec.yaml': 'dart',
  'CMakeLists.txt': 'cpp',
  'Makefile': 'generic',
};

/** Map of filenames to package managers. */
const PACKAGE_MANAGER_FILES: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'bun.lockb': 'bun',
  'Pipfile.lock': 'pipenv',
  'poetry.lock': 'poetry',
  'requirements.txt': 'pip',
  'go.sum': 'go',
  'Cargo.lock': 'cargo',
};

/** Map of filenames to frameworks. */
const FRAMEWORK_FILES: Record<string, string> = {
  'next.config.js': 'Next.js',
  'next.config.ts': 'Next.js',
  'next.config.mjs': 'Next.js',
  'nuxt.config.ts': 'Nuxt',
  'nuxt.config.js': 'Nuxt',
  'angular.json': 'Angular',
  'svelte.config.js': 'SvelteKit',
  'astro.config.mjs': 'Astro',
  'remix.config.js': 'Remix',
  'vite.config.ts': 'Vite',
  'vite.config.js': 'Vite',
  'webpack.config.js': 'Webpack',
  'cdk.json': 'AWS CDK',
  'serverless.yml': 'Serverless Framework',
  'terraform.tf': 'Terraform',
  'Dockerfile': 'Docker',
  'docker-compose.yml': 'Docker Compose',
  'docker-compose.yaml': 'Docker Compose',
  '.github/workflows': 'GitHub Actions',
  '.gitlab-ci.yml': 'GitLab CI',
  'Jenkinsfile': 'Jenkins',
};

/**
 * Infer the primary project type from detected files and languages.
 *
 * @param files - List of filenames in the repository root
 * @param languages - Language percentages
 * @returns Project type string (e.g. "nodejs", "python")
 */
export function inferProjectType(files: string[], languages: Record<string, number>): string {
  for (const file of files) {
    if (PROJECT_TYPE_FILES[file]) return PROJECT_TYPE_FILES[file];
  }
  // Fallback: use dominant language
  const sorted = Object.entries(languages).sort(([, a], [, b]) => b - a);
  if (sorted.length > 0) {
    const lang = sorted[0][0].toLowerCase();
    if (lang.includes('typescript') || lang.includes('javascript')) return 'nodejs';
    if (lang.includes('python')) return 'python';
    if (lang.includes('go')) return 'go';
    if (lang.includes('java') || lang.includes('kotlin')) return 'java';
    if (lang.includes('rust')) return 'rust';
    if (lang.includes('ruby')) return 'ruby';
    return lang;
  }
  return 'unknown';
}

/**
 * Infer the package manager from detected files.
 *
 * @param files - List of filenames in the repository root
 * @returns Package manager name or "unknown"
 */
export function inferPackageManager(files: string[]): string {
  for (const file of files) {
    if (PACKAGE_MANAGER_FILES[file]) return PACKAGE_MANAGER_FILES[file];
  }
  return 'unknown';
}

/**
 * Infer frameworks from detected files.
 *
 * @param files - List of filenames in the repository root
 * @returns Array of detected framework names
 */
export function inferFrameworks(files: string[]): string[] {
  const frameworks: string[] = [];
  for (const file of files) {
    const fw = FRAMEWORK_FILES[file];
    if (fw && !frameworks.includes(fw)) frameworks.push(fw);
  }
  return frameworks;
}

// Provider-Specific Analyzers

/**
 * Analyze a GitHub repository via the GitHub REST API.
 *
 * @param parsed - Parsed Git URL with owner/repo
 * @param token - Optional GitHub personal access token for private repos
 * @returns Repository analysis
 */
async function analyzeGitHubRepo(parsed: ParsedGitUrl, token?: string): Promise<RepoAnalysis> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'pipeline-builder',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const baseUrl = GITHUB_API_BASE_URL;

  // Fetch repo metadata + languages + root contents in parallel
  const [repoRes, langRes, contentsRes] = await Promise.all([
    fetch(`${baseUrl}/repos/${parsed.owner}/${parsed.repo}`, { headers }),
    fetch(`${baseUrl}/repos/${parsed.owner}/${parsed.repo}/languages`, { headers }),
    fetch(`${baseUrl}/repos/${parsed.owner}/${parsed.repo}/contents/`, { headers }),
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

/**
 * Analyze a GitLab repository via the GitLab REST API.
 *
 * @param parsed - Parsed Git URL with owner/repo
 * @param token - Optional GitLab personal access token for private repos
 * @returns Repository analysis
 */
async function analyzeGitLabRepo(parsed: ParsedGitUrl, token?: string): Promise<RepoAnalysis> {
  const headers: Record<string, string> = {};
  if (token) headers['PRIVATE-TOKEN'] = token;

  const projectId = encodeURIComponent(`${parsed.owner}/${parsed.repo}`);
  const baseUrl = `https://${parsed.host}/api/v4`;

  const [repoRes, langRes, treeRes] = await Promise.all([
    fetch(`${baseUrl}/projects/${projectId}`, { headers }),
    fetch(`${baseUrl}/projects/${projectId}/languages`, { headers }),
    fetch(`${baseUrl}/projects/${projectId}/repository/tree?per_page=100`, { headers }),
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

/**
 * Analyze a Bitbucket repository via the Bitbucket REST API.
 *
 * @param parsed - Parsed Git URL with owner/repo
 * @param token - Optional Bitbucket app password for private repos
 * @returns Repository analysis
 */
async function analyzeBitbucketRepo(parsed: ParsedGitUrl, token?: string): Promise<RepoAnalysis> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const baseUrl = BITBUCKET_API_BASE_URL;

  const [repoRes, srcRes] = await Promise.all([
    fetch(`${baseUrl}/repositories/${parsed.owner}/${parsed.repo}`, { headers }),
    fetch(`${baseUrl}/repositories/${parsed.owner}/${parsed.repo}/src/?pagelen=100`, { headers }),
  ]);

  if (!repoRes.ok) {
    throw new Error(`Bitbucket API error: ${repoRes.status} ${repoRes.statusText}`);
  }

  const repoData = await repoRes.json() as Record<string, unknown>;
  const mainBranch = repoData.mainbranch as Record<string, unknown> | undefined;
  const language = repoData.language as string | undefined;

  const srcData = srcRes.ok
    ? (await srcRes.json() as { values?: Array<{ path: string; type: string }> })
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

/**
 * Build a full RepoAnalysis from parsed URL + raw API data.
 *
 * @param parsed - Parsed Git URL
 * @param raw - Raw data from the provider API
 * @returns Complete repository analysis
 */
function buildAnalysis(
  parsed: ParsedGitUrl,
  raw: {
    defaultBranch: string;
    description: string;
    topics: string[];
    languages: Record<string, number>;
    detectedFiles: string[];
  },
): RepoAnalysis {
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    host: parsed.host,
    provider: parsed.provider,
    defaultBranch: raw.defaultBranch,
    description: raw.description,
    topics: raw.topics,
    languages: raw.languages,
    detectedFiles: raw.detectedFiles,
    projectType: inferProjectType(raw.detectedFiles, raw.languages),
    hasDockerfile: raw.detectedFiles.some((f) => f === 'Dockerfile'),
    hasCdkJson: raw.detectedFiles.some((f) => f === 'cdk.json'),
    packageManager: inferPackageManager(raw.detectedFiles),
    frameworks: inferFrameworks(raw.detectedFiles),
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

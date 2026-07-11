// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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

/**
 * Build a full RepoAnalysis from parsed URL + raw API data.
 *
 * @param parsed - Parsed Git URL
 * @param raw - Raw data from the provider API
 * @returns Complete repository analysis
 */
export function buildAnalysis(
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

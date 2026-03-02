/**
 * Unit tests for the Git analysis service — URL parsing, project type inference,
 * package manager detection, framework detection, and enhanced prompt builder.
 *
 * @module test/git-analysis-service
 */

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

import {
  parseGitUrl,
  inferProjectType,
  inferPackageManager,
  inferFrameworks,
  buildEnhancedPrompt,
  type RepoAnalysis,
} from '../src/services/git-analysis-service';

// ---------------------------------------------------------------------------
// parseGitUrl
// ---------------------------------------------------------------------------

describe('parseGitUrl', () => {
  it('parses GitHub HTTPS URL', () => {
    const result = parseGitUrl('https://github.com/owner/repo');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });

  it('parses GitHub HTTPS URL with .git suffix', () => {
    const result = parseGitUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });

  it('parses GitHub URL with tree path', () => {
    const result = parseGitUrl('https://github.com/owner/repo/tree/main/src');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });

  it('parses GitHub URL with blob path', () => {
    const result = parseGitUrl('https://github.com/owner/repo/blob/main/README.md');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });

  it('parses GitHub SSH URL', () => {
    const result = parseGitUrl('git@github.com:owner/repo.git');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });

  it('parses GitHub SSH URL without .git suffix', () => {
    const result = parseGitUrl('git@github.com:owner/repo');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });

  it('parses SSH URL with protocol prefix', () => {
    const result = parseGitUrl('ssh://git@github.com/owner/repo.git');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });

  it('parses GitLab HTTPS URL', () => {
    const result = parseGitUrl('https://gitlab.com/group/repo');
    expect(result).toEqual({ host: 'gitlab.com', owner: 'group', repo: 'repo', provider: 'gitlab' });
  });

  it('parses GitLab SSH URL', () => {
    const result = parseGitUrl('git@gitlab.com:group/repo.git');
    expect(result).toEqual({ host: 'gitlab.com', owner: 'group', repo: 'repo', provider: 'gitlab' });
  });

  it('parses GitLab nested groups', () => {
    const result = parseGitUrl('https://gitlab.com/group/subgroup/repo');
    expect(result).toEqual({ host: 'gitlab.com', owner: 'group/subgroup', repo: 'repo', provider: 'gitlab' });
  });

  it('parses Bitbucket HTTPS URL', () => {
    const result = parseGitUrl('https://bitbucket.org/owner/repo');
    expect(result).toEqual({ host: 'bitbucket.org', owner: 'owner', repo: 'repo', provider: 'bitbucket' });
  });

  it('parses self-hosted URL as unknown provider', () => {
    const result = parseGitUrl('https://git.company.com/team/project');
    expect(result).toEqual({ host: 'git.company.com', owner: 'team', repo: 'project', provider: 'unknown' });
  });

  it('returns null for invalid URL', () => {
    expect(parseGitUrl('not-a-url')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGitUrl('')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parseGitUrl(null as unknown as string)).toBeNull();
    expect(parseGitUrl(undefined as unknown as string)).toBeNull();
  });

  it('returns null for URL with only host (no owner/repo)', () => {
    expect(parseGitUrl('https://github.com/')).toBeNull();
    expect(parseGitUrl('https://github.com/onlyone')).toBeNull();
  });

  it('trims whitespace from input', () => {
    const result = parseGitUrl('  https://github.com/owner/repo  ');
    expect(result).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', provider: 'github' });
  });
});

// ---------------------------------------------------------------------------
// inferProjectType
// ---------------------------------------------------------------------------

describe('inferProjectType', () => {
  it('detects Node.js from package.json', () => {
    expect(inferProjectType(['package.json', 'README.md'], {})).toBe('nodejs');
  });

  it('detects Python from requirements.txt', () => {
    expect(inferProjectType(['requirements.txt'], {})).toBe('python');
  });

  it('detects Python from pyproject.toml', () => {
    expect(inferProjectType(['pyproject.toml'], {})).toBe('python');
  });

  it('detects Go from go.mod', () => {
    expect(inferProjectType(['go.mod'], {})).toBe('go');
  });

  it('detects Java from pom.xml', () => {
    expect(inferProjectType(['pom.xml'], {})).toBe('java');
  });

  it('detects Rust from Cargo.toml', () => {
    expect(inferProjectType(['Cargo.toml'], {})).toBe('rust');
  });

  it('falls back to dominant language when no known files', () => {
    expect(inferProjectType(['README.md'], { TypeScript: 80, JavaScript: 20 })).toBe('nodejs');
  });

  it('falls back to python from language', () => {
    expect(inferProjectType([], { Python: 90 })).toBe('python');
  });

  it('returns unknown when no files or languages', () => {
    expect(inferProjectType([], {})).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// inferPackageManager
// ---------------------------------------------------------------------------

describe('inferPackageManager', () => {
  it('detects pnpm from pnpm-lock.yaml', () => {
    expect(inferPackageManager(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm');
  });

  it('detects yarn from yarn.lock', () => {
    expect(inferPackageManager(['yarn.lock', 'package.json'])).toBe('yarn');
  });

  it('detects npm from package-lock.json', () => {
    expect(inferPackageManager(['package-lock.json', 'package.json'])).toBe('npm');
  });

  it('detects pip from requirements.txt', () => {
    expect(inferPackageManager(['requirements.txt'])).toBe('pip');
  });

  it('detects poetry from poetry.lock', () => {
    expect(inferPackageManager(['poetry.lock', 'pyproject.toml'])).toBe('poetry');
  });

  it('returns unknown when no lock files', () => {
    expect(inferPackageManager(['README.md'])).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// inferFrameworks
// ---------------------------------------------------------------------------

describe('inferFrameworks', () => {
  it('detects Next.js from next.config.ts', () => {
    expect(inferFrameworks(['next.config.ts', 'package.json'])).toContain('Next.js');
  });

  it('detects AWS CDK from cdk.json', () => {
    expect(inferFrameworks(['cdk.json'])).toContain('AWS CDK');
  });

  it('detects Docker from Dockerfile', () => {
    expect(inferFrameworks(['Dockerfile'])).toContain('Docker');
  });

  it('detects multiple frameworks', () => {
    const result = inferFrameworks(['next.config.js', 'Dockerfile', 'docker-compose.yml']);
    expect(result).toContain('Next.js');
    expect(result).toContain('Docker');
    expect(result).toContain('Docker Compose');
  });

  it('returns empty array when no frameworks detected', () => {
    expect(inferFrameworks(['README.md'])).toEqual([]);
  });

  it('does not duplicate framework entries', () => {
    const result = inferFrameworks(['next.config.js', 'next.config.ts']);
    const nextCount = result.filter(f => f === 'Next.js').length;
    expect(nextCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildEnhancedPrompt
// ---------------------------------------------------------------------------

describe('buildEnhancedPrompt', () => {
  const baseAnalysis: RepoAnalysis = {
    owner: 'facebook',
    repo: 'react',
    host: 'github.com',
    provider: 'github',
    defaultBranch: 'main',
    description: 'A declarative library for building UIs',
    topics: ['react', 'javascript', 'ui'],
    languages: { JavaScript: 60, TypeScript: 30, CSS: 10 },
    detectedFiles: ['package.json', 'Dockerfile'],
    projectType: 'nodejs',
    hasDockerfile: true,
    hasCdkJson: false,
    packageManager: 'yarn',
    frameworks: ['Docker'],
  };

  it('includes owner/repo in prompt', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('facebook/react');
  });

  it('includes project type', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('Project type: nodejs');
  });

  it('includes languages', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('JavaScript (60%)');
    expect(prompt).toContain('TypeScript (30%)');
  });

  it('includes description', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('A declarative library for building UIs');
  });

  it('includes frameworks', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('Frameworks: Docker');
  });

  it('includes package manager', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('Package manager: yarn');
  });

  it('mentions Dockerfile when present', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('contains a Dockerfile');
  });

  it('mentions cdk.json when present', () => {
    const prompt = buildEnhancedPrompt({ ...baseAnalysis, hasCdkJson: true });
    expect(prompt).toContain('cdk.json');
  });

  it('uses github source type for GitHub repos', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('type "github"');
  });

  it('uses codestar source type for non-GitHub repos', () => {
    const prompt = buildEnhancedPrompt({ ...baseAnalysis, provider: 'gitlab' });
    expect(prompt).toContain('type "codestar"');
  });

  it('includes topics', () => {
    const prompt = buildEnhancedPrompt(baseAnalysis);
    expect(prompt).toContain('Topics: react, javascript, ui');
  });

  it('omits description when empty', () => {
    const prompt = buildEnhancedPrompt({ ...baseAnalysis, description: '' });
    expect(prompt).not.toContain('Repository description:');
  });

  it('omits package manager when unknown', () => {
    const prompt = buildEnhancedPrompt({ ...baseAnalysis, packageManager: 'unknown' });
    expect(prompt).not.toContain('Package manager:');
  });
});

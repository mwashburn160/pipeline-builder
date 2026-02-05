import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { TypeScriptProject } from 'projen/lib/typescript';
import { PackageProject } from './projenrc/package';

let branch = 'main';
let pnpmVersion = '10.25.0';
let constructsVersion = '10.4.5';
let typescriptVersion = '5.9.3';
let expressVersion = '5.2.1'

let root = new TypeScriptProject({
  name: '@mwashburn160/root',
  defaultReleaseBranch: branch,
  projenVersion: '0.99.8',
  minNodeVersion: '24.9.0',
  minMajorVersion: 1,
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  depsUpgrade: true,
  typescriptVersion: typescriptVersion,
  gitignore: ['.DS_Store', '.nx', '.lock', '.next', '.vscode', 'dist', 'test-reports', 'db-data', 'pgadmin-data', 'registry-data', '.aws-sam'],
  licensed: true,
  projenrcTs: true,
  jest: false,
  eslint: false,
  buildWorkflow: false,
  release: false,
  sampleCode: false,
  npmAccess: NpmAccess.RESTRICTED,
  devDeps: [
    '@swc-node/core@1.14.1',
    '@swc-node/register@1.11.1',
    `constructs@${constructsVersion}`,
    'npm-check-updates@19.3.2'
  ]
});
root.addScripts({
  'npm-check': 'npx npm-check-updates'
});

/**
 * Package Architecture (Feb 2026 Refactoring - Final)
 *
 * Total Deduplication: ~1,250 lines of duplicate code eliminated
 *
 * Build Order (dependencies):
 * 1. api-core (no internal deps)
 * 2. pipeline-data → api-core
 * 3. pipeline-core → api-core + pipeline-data
 * 4. api-server → api-core + pipeline-core
 *
 * Responsibilities:
 * - api-core: Shared API utilities
 *   • Authentication middleware (JWT): authenticateToken, requireAdmin, etc.
 *   • HTTP client: InternalHttpClient, createSafeClient
 *   • Response utilities: sendSuccess, sendError, sendPaginated
 *   • Logging, identity extraction, parameter parsing
 *   • Error codes and HTTP status constants
 *   • Quota service client interface
 *
 * - api-server: Express server infrastructure
 *   • App factory with middleware (CORS, Helmet, rate limiting)
 *   • Server lifecycle management with graceful shutdown
 *   • SSE connection manager for real-time events
 *   • Request context creation (identity + logging + SSE)
 *   • Re-exports api-core utilities for convenience
 *
 * - pipeline-data: Database layer
 *   • Drizzle ORM schemas (plugins, pipelines)
 *   • PostgreSQL connection management with retry logic
 *   • Type-safe query builders with generic CRUD operations
 *   • Query filters and pagination utilities
 *
 * - pipeline-core: CDK infrastructure + Configuration
 *   • AWS CDK constructs for pipeline building
 *   • Application configuration (Config class)
 *   • Pipeline types, helpers, and metadata
 *   • Network resolution (VPC/subnet lookup)
 *   • Re-exports pipeline-data and api-core utilities
 */

// =============================================================================
// API Core - Shared API utilities (authentication, HTTP client, responses)
// =============================================================================
let api_core = new PackageProject({
  parent: root,
  name: '@mwashburn160/api-core',
  outdir: './packages/api-core',
  defaultReleaseBranch: 'main',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
  deps: [
    `express@${expressVersion}`,
    'jsonwebtoken@9.0.3',
    'winston@3.17.0',
    'axios@1.13.3'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/node@24.9.0',
    `typescript@${typescriptVersion}`
  ]
});
api_core.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
api_core.eslint?.addRules({ '@typescript-eslint/no-shadow': 'off' });
api_core.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });


// =============================================================================
// Workspace Configuration
// =============================================================================
new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });

root.synth();
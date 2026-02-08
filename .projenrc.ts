/**
 * Projen Configuration for Pipeline Builder Monorepo
 *
 * This file defines the entire project structure using Projen, a project
 * configuration and build tool. It manages:
 * - Monorepo architecture with PNPM workspaces
 * - Core packages (api-core, api-server, pipeline-data, pipeline-core)
 * - Service projects (quota, plugin, pipeline, platform, frontend)
 * - CLI tool (pipeline-manager)
 * - Build orchestration with Nx
 * - GitHub Actions workflows
 * - VSCode settings
 *
 * @see https://github.com/projen/projen
 */

import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { TypeScriptProject } from 'projen/lib/typescript';
import { PackageProject } from './projenrc/package';

// =============================================================================
// Version Constants
// =============================================================================
// These centralized version numbers ensure consistency across all packages
// and make it easier to update dependencies across the monorepo.

/** Default Git branch for all projects */
let branch = 'main';

/** PNPM package manager version (used in CI/CD workflows) */
let pnpmVersion = '10.25.0';

/** AWS CDK Constructs library version (for CDK infrastructure) */
let constructsVersion = '10.4.5';

/** TypeScript compiler version (consistent across all packages) */
let typescriptVersion = '5.9.3';

/** AWS CDK library version (for infrastructure as code) */
let cdkVersion = '2.237.0';

/** Express.js framework version (for API servers) */
let expressVersion = '5.2.1'

// Internal package versions — use workspace protocol for local resolution
/** @mwashburn160/api-core package version */
let apiCoreVersion = '1.8.0';

/** @mwashburn160/pipeline-data package version */
let pipelineDataVersion = '1.8.0';



// =============================================================================
// Root Project Configuration
// =============================================================================
/**
 * Root monorepo project definition.
 *
 * This TypeScript project serves as the root of the monorepo and defines:
 * - Package manager configuration (PNPM)
 * - TypeScript version for the entire workspace
 * - Global gitignore patterns
 * - Workspace-level dependencies
 * - Top-level scripts and tasks
 *
 * All child projects inherit settings from this root configuration unless
 * explicitly overridden.
 */
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
  // Ignore common development artifacts and data directories
  gitignore: ['.DS_Store', '.nx', '.lock', '.next', '.vscode', 'dist', 'test-reports', 'db-data', 'pgadmin-data', 'registry-data', '.aws-sam'],
  licensed: true,
  projenrcTs: true,
  jest: false,
  eslint: false,
  buildWorkflow: false,  // Custom workflow defined separately
  release: false,        // Manual release process
  sampleCode: false,     // No sample code generation
  npmAccess: NpmAccess.RESTRICTED,
  devDeps: [
    '@swc-node/core@1.14.1',       // Fast TypeScript compiler for development
    '@swc-node/register@1.11.1',   // SWC TypeScript loader for Node.js
    `constructs@${constructsVersion}`, // AWS CDK constructs library
    'npm-check-updates@19.3.2'     // Dependency update checker
  ]
});

/**
 * Add custom npm scripts to the root package.
 * These scripts are available from the workspace root.
 */
root.addScripts({
  // Check for outdated dependencies across the entire monorepo
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
/**
 * Core API utilities package (@mwashburn160/api-core)
 *
 * This is the foundational package for all API services in the monorepo.
 * It has NO internal dependencies and provides shared functionality for:
 *
 * - JWT authentication middleware (authenticateToken, requireAdmin, etc.)
 * - HTTP client utilities (InternalHttpClient, createSafeClient)
 * - Response standardization (sendSuccess, sendError, sendPaginated)
 * - Request identity extraction and validation
 * - Parameter parsing and validation
 * - Logging infrastructure (Winston)
 * - Error codes and HTTP status constants
 * - Quota service client interface
 *
 * All other packages depend on this package for common API functionality.
 *
 * @dependency express - Type definitions for Express Request/Response
 * @dependency jsonwebtoken - JWT token generation and validation
 * @dependency winston - Structured logging
 * @dependency axios - HTTP client for service-to-service communication
 */
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
    `express@${expressVersion}`,  // Express types for middleware definitions
    'jsonwebtoken@9.0.3',         // JWT authentication
    'winston@3.17.0',             // Structured logging
    'axios@1.13.3'                // HTTP client
  ],
  devDeps: [
    '@types/express@5.0.6',       // Express type definitions
    '@types/jsonwebtoken@9.0.10', // JWT type definitions
    '@types/node@24.9.0',         // Node.js type definitions
    `typescript@${typescriptVersion}`
  ]
});
// Disable problematic ESLint rules for this package
api_core.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
api_core.eslint?.addRules({ '@typescript-eslint/no-shadow': 'off' });
api_core.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });

// =============================================================================
// Pipeline Data - Database layer (Drizzle ORM, query builders)
// =============================================================================
/**
 * Database layer package (@mwashburn160/pipeline-data)
 *
 * This package encapsulates all database interactions and provides:
 *
 * - Drizzle ORM schema definitions for plugins and pipelines
 * - PostgreSQL connection management with automatic retry logic
 * - Type-safe query builders with generic CRUD operations
 * - Query filters and pagination utilities
 * - Database helper functions (timestamps, soft delete)
 * - BaseQueryBuilder with reusable insert/update/delete methods
 *
 * Key Design Decision:
 * This package uses environment variables directly (no Config dependency)
 * to avoid circular dependencies. Configuration is kept minimal and
 * focused on database connectivity only.
 *
 * @dependency api-core - Logging and error handling
 * @dependency pg - PostgreSQL client library
 * @dependency drizzle-orm - Type-safe ORM with SQL query builder
 */
let pipeline_data = new PackageProject({
  parent: root,
  name: '@mwashburn160/pipeline-data',
  outdir: './packages/pipeline-data',
  defaultReleaseBranch: 'main',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
  deps: [
    `@mwashburn160/api-core@${apiCoreVersion}`, // Logging and utilities
    'pg@8.16.3',                                 // PostgreSQL client
    'drizzle-orm@0.45.1'                         // Type-safe ORM
  ],
  devDeps: [
    '@types/node@24.9.0',  // Node.js type definitions
    '@types/pg@8.16.0',    // PostgreSQL type definitions
    `typescript@${typescriptVersion}`
  ]
});
// Disable problematic ESLint rules for this package
pipeline_data.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
pipeline_data.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });

// =============================================================================
// Pipeline Core - CDK infrastructure + Configuration
// =============================================================================
/**
 * CDK infrastructure and configuration package (@mwashburn160/pipeline-core)
 *
 * This package combines AWS CDK constructs with application configuration:
 *
 * - AWS CDK constructs for building CodePipeline infrastructure
 * - Application configuration (Config class with environment variables)
 * - Pipeline types, helpers, and metadata
 * - Network resolution utilities (VPC/subnet lookup)
 * - Re-exports pipeline-data for convenience (consumers get both)
 * - Re-exports api-core utilities (HTTP client, etc.)
 *
 * This package is used by:
 * - CDK stacks for infrastructure deployment
 * - CLI tools for pipeline management
 * - API services that need configuration and database access
 *
 * @dependency api-core - Shared utilities
 * @dependency pipeline-data - Database layer (re-exported)
 * @dependency aws-cdk-lib - AWS CDK infrastructure constructs
 * @dependency constructs - CDK construct base classes
 * @dependency jsonwebtoken - JWT utilities for service authentication
 * @dependency axios - HTTP client for AWS API calls
 * @dependency uuid - Unique identifier generation
 */
let pipeline_core = new PackageProject({
  parent: root,
  name: '@mwashburn160/pipeline-core',
  outdir: './packages/pipeline-core',
  defaultReleaseBranch: 'main',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
  deps: [
    `@mwashburn160/api-core@${apiCoreVersion}`,           // Shared utilities
    `@mwashburn160/pipeline-data@${pipelineDataVersion}`, // Database layer
    `constructs@${constructsVersion}`,                    // CDK constructs
    `aws-cdk-lib@${cdkVersion}`,                          // AWS CDK library
    'jsonwebtoken@9.0.3',                                 // JWT utilities
    'axios@1.13.3',                                       // HTTP client
    'uuid@13.0.0'                                         // UUID generation
  ],
  devDeps: [
    '@types/node@24.9.0',         // Node.js type definitions
    '@types/aws-lambda@8.10.159', // AWS Lambda type definitions
    '@types/jsonwebtoken@9.0.10', // JWT type definitions
    '@jest/globals@30.2.0'        // Jest testing framework
  ]
});
// Disable problematic ESLint rules for this package
pipeline_core.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
pipeline_core.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });

// =============================================================================
// Workspace Configuration
// =============================================================================
/**
 * Configure the monorepo workspace with additional tooling.
 *
 * These configurations enable:
 * - Nx: Build orchestration and caching for faster builds
 * - PnpmWorkspace: PNPM workspace configuration for monorepo
 * - VscodeSettings: Shared VSCode settings for consistent development
 * - Workflow: GitHub Actions CI/CD workflows
 */

/**
 * Nx build orchestration
 * - Enables incremental builds with dependency graph
 * - Caches build outputs for faster rebuilds
 * - Parallelizes tasks across packages
 */
new Nx(root);

/**
 * PNPM workspace configuration
 * - Defines workspace packages in pnpm-workspace.yaml
 * - Enables shared dependencies and workspace protocols
 */
new PnpmWorkspace(root);

/**
 * VSCode settings
 * - Shared editor configuration
 * - TypeScript settings
 * - ESLint and Prettier integration
 */
new VscodeSettings(root);

/**
 * GitHub Actions workflow
 * - CI/CD pipeline for testing and building
 * - Uses the specified PNPM version
 */
new Workflow(root, { pnpmVersion });

/**
 * Synthesize all project configurations
 * This generates all project files (package.json, tsconfig.json, etc.)
 * based on the definitions above.
 */
root.synth();
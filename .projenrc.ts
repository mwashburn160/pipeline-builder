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
import { ManagerProject } from './projenrc/manager';
import { FrontEndProject } from './projenrc/frontend'
import { FunctionProject } from './projenrc/function';
import { TypeScriptProject } from 'projen/lib/typescript';
import { PackageProject } from './projenrc/package';
import { WebTokenProject } from './projenrc/web-token';

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
let apiCoreVersion = '1.18.4';

/** @mwashburn160/pipeline-data package version */
let pipelineDataVersion = '1.19.4';

/** @mwashburn160/pipeline-core package version */
let pipelineCoreVersion = '1.19.4';

/** @mwashburn160/api-server package version */
let apiServerVersion = '1.16.4';

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
    'axios@1.13.3',               // HTTP client
    'zod@4.3.6'                   // Runtime type validation
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
// API Server - Express server infrastructure (SSE, request context)
// =============================================================================
/**
 * Express server infrastructure package (@mwashburn160/api-server)
 *
 * This package provides production-ready Express.js server infrastructure:
 *
 * - Application factory with pre-configured middleware (CORS, Helmet, rate limiting)
 * - Server lifecycle management with graceful shutdown handling
 * - SSE (Server-Sent Events) connection manager for real-time updates
 * - Request context creation (combines identity + logging + SSE)
 * - Re-exports authentication middleware from api-core for convenience
 *
 * All API services (quota, plugin, pipeline, platform) use this package
 * to standardize their Express server setup and lifecycle management.
 *
 * Key Features:
 * - Automatic error handling middleware
 * - Request ID generation and tracking
 * - Structured logging integration
 * - Security headers (Helmet)
 * - CORS configuration
 * - Rate limiting
 *
 * @dependency api-core - Shared utilities and authentication
 * @dependency pipeline-core - Configuration and database access
 * @dependency express - Web framework
 * @dependency express-rate-limit - Rate limiting middleware
 * @dependency helmet - Security headers middleware
 * @dependency cors - CORS middleware
 * @dependency jsonwebtoken - JWT authentication
 * @dependency uuid - Request ID generation
 */
let api_server = new PackageProject({
  parent: root,
  name: '@mwashburn160/api-server',
  outdir: './packages/api-server',
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
    `@mwashburn160/pipeline-core@${pipelineCoreVersion}`, // Config + database
    `express@${expressVersion}`,                          // Web framework
    'express-rate-limit@8.2.1',                           // Rate limiting
    'helmet@8.1.0',                                       // Security headers
    'cors@2.8.6',                                         // CORS middleware
    'jsonwebtoken@9.0.3',                                 // JWT authentication
    'uuid@13.0.0'                                         // UUID generation
  ],
  devDeps: [
    '@types/express@5.0.6',                // Express type definitions
    '@types/express-serve-static-core@5.1.1', // Express core types
    '@types/cors@2.8.19',                  // CORS type definitions
    '@types/jsonwebtoken@9.0.10',          // JWT type definitions
    '@types/node@24.9.0',                  // Node.js type definitions
    `typescript@${typescriptVersion}`
  ]
});
// Disable problematic ESLint rules for this package
api_server.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
api_server.eslint?.addRules({ 'import/no-unresolved': 'off' });
api_server.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });

// =============================================================================
// Pipeline Manager - CLI tool for pipeline management
// =============================================================================
/**
 * Pipeline Manager CLI tool (@mwashburn160/pipeline-manager)
 *
 * Command-line interface for managing CI/CD pipelines:
 *
 * - Interactive pipeline creation and deployment
 * - Plugin upload and management
 * - Pipeline YAML configuration
 * - AWS CDK stack deployment
 * - Progress tracking and status updates
 *
 * This is a binary package that can be installed globally or run via npx.
 *
 * @dependency pipeline-core - Pipeline configuration and CDK constructs
 * @dependency aws-cdk-lib - AWS CDK deployment
 * @dependency commander - CLI argument parsing
 * @dependency figlet - ASCII art banners
 * @dependency axios - HTTP client for API calls
 * @dependency progress - Progress bar rendering
 * @dependency picocolors - Terminal colors
 * @dependency yaml - YAML configuration parsing
 * @dependency ora - Terminal spinners
 * @dependency form-data - Multipart form uploads
 */
let manager = new ManagerProject({
  parent: root,
  name: '@mwashburn160/pipeline-manager',
  outdir: './packages/pipeline-manager',
  defaultReleaseBranch: 'main',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
  bin: {
    'pipeline-manager': './dist/cli.js'  // CLI executable
  },
  deps: [
    `@mwashburn160/pipeline-core@${pipelineCoreVersion}`, // Pipeline config
    `typescript@${typescriptVersion}`,                    // TypeScript runtime
    `aws-cdk-lib@${cdkVersion}`,                          // AWS CDK
    'form-data@4.0.5',                                    // Multipart uploads
    'commander@14.0.2',                                   // CLI framework
    'figlet@1.10.0',                                      // ASCII art
    'axios@1.13.3',                                       // HTTP client
    'progress@2.0.3',                                     // Progress bars
    'picocolors@1.1.1',                                   // Terminal colors
    'yaml@2.8.2',                                         // YAML parsing
    'ora@9.1.0'                                           // Terminal spinners
  ],
  devDeps: [
    '@types/figlet@1.7.0',   // Figlet type definitions
    '@types/progress@2.0.7', // Progress type definitions
    'copyfiles@2.4.1'        // File copying utility
  ]
})
// Disable problematic ESLint rules for this package
manager.eslint?.addRules({ '@typescript-eslint/no-shadow': 'off' });
manager.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

/**
 * Post-compile tasks: Copy configuration files to dist directory
 * These files are needed at runtime by the CLI tool
 */
manager.postCompileTask.exec('copyfiles -f ./cdk.json dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./config.yml dist/ --verbose --error');

// =============================================================================
// Platform Service - User authentication and organization management
// =============================================================================
/**
 * Platform service (platform)
 *
 * Multi-database platform service for user authentication and organization management:
 *
 * - User registration, login, and JWT token issuance
 * - Organization creation and management
 * - Email verification and password reset flows
 * - User profile management
 * - MongoDB for user/organization data
 * - PostgreSQL for relational data
 *
 * This service issues JWT tokens that are used by other services for authentication.
 *
 * @dependency express - Web framework
 * @dependency express-rate-limit - Rate limiting for auth endpoints
 * @dependency nodemailer - Email sending (verification, password reset)
 * @dependency jsonwebtoken - JWT token generation
 * @dependency slugify - Generate URL-friendly organization slugs
 * @dependency winston - Structured logging
 * @dependency bcryptjs - Password hashing
 * @dependency mongoose - MongoDB ODM for user data
 * @dependency helmet - Security headers
 * @dependency cors - CORS middleware
 * @dependency pg - PostgreSQL client
 * @dependency drizzle-orm - PostgreSQL ORM
 * @dependency uuid - UUID generation
 * @dependency yaml - Configuration parsing
 * @dependency adm-zip - File archive handling
 * @dependency multer - File upload handling
 */
let platform = new WebTokenProject({
  parent: root,
  name: 'platform',
  outdir: './platform',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/api-core@${apiCoreVersion}`, // API core utilities (logging, validation, errors)
    `express@${expressVersion}`,  // Web framework
    'express-rate-limit@8.2.1',   // Rate limiting
    'nodemailer@7.0.13',          // Email sending
    'zod@4.3.6',                  // Runtime type validation
    '@aws-sdk/client-sesv2@3.821.0', // AWS SES v2 email transport
    'jsonwebtoken@9.0.3',         // JWT tokens
    'slugify@1.6.6',              // URL slugs
    'winston@3.19.0',             // Logging
    'bcryptjs@3.0.3',             // Password hashing
    'mongoose@9.1.5',             // MongoDB ODM
    'helmet@8.1.0',               // Security headers
    'cors@2.8.6',                 // CORS
    'pg@8.16.3',                  // PostgreSQL client
    'drizzle-orm@0.45.1',         // PostgreSQL ORM
    'uuid@13.0.0',                // UUID generation
    'yaml@2.8.2',                 // YAML parsing
    'adm-zip@0.5.16',             // ZIP handling
    'multer@2.0.2'                // File uploads
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/express-serve-static-core@5.1.1',
    '@types/nodemailer@7.0.9',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@types/adm-zip@0.5.7',
    '@types/multer@2.0.0',
    '@jest/globals@30.2.0'
  ]
});

/**
 * Add npm scripts for the platform service.
 * Docker scripts use environment variables for configuration:
 * - PROJECT_NAME: Docker image name (default: platform)
 * - REGISTRY: Container registry (default: ghcr.io/mwashburn160)
 * - WORKSPACE: Build context directory
 */
platform.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-platform}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-platform}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-platform}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-platform}:$(jq -r .version package.json)'
});
// Disable problematic ESLint rules for this service
platform.eslint?.addRules({ '@stylistic/max-len': 'off' });
platform.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });
platform.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

// =============================================================================
// Frontend - Next.js web application
// =============================================================================
/**
 * Frontend web application (frontend)
 *
 * Next.js-based web interface for pipeline management:
 *
 * - User authentication and registration UI
 * - Pipeline creation and management interface
 * - Plugin upload and configuration
 * - Real-time pipeline status updates
 * - Organization and team management
 *
 * This is a server-side rendered React application built with Next.js 14.
 *
 * @dependency api-core - Shared API utilities
 * @dependency api-server - Server infrastructure
 * @dependency pipeline-core - Pipeline types and configuration
 * @dependency next - React framework with SSR
 * @dependency react - UI library
 * @dependency react-dom - React DOM renderer
 * @dependency lucide-react - Icon library
 * @dependency clsx - Conditional className utility
 * @dependency tailwindcss - Utility-first CSS framework
 */
let frontend = new FrontEndProject({
  parent: root,
  name: 'frontend',
  outdir: './frontend',
  defaultReleaseBranch: branch,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  // Frontend-specific gitignore patterns
  gitignore: ['.DS_Store', 'yarn.lock', '.next', '.vscode', 'dist'],
  deps: [
    `@mwashburn160/api-core@${apiCoreVersion}`,           // API utilities
    `@mwashburn160/api-server@${apiServerVersion}`,       // Server infrastructure
    `@mwashburn160/pipeline-core@${pipelineCoreVersion}`, // Pipeline types
    'next@14.2.0',                                        // React framework
    'react@18.2.0',                                       // UI library
    'react-dom@18.2.0',                                   // DOM renderer
    'lucide-react@0.563.0',                               // Icons
    'clsx@^2.1.1',                                        // Conditional classes
    'tailwindcss@4.1.18',                                 // CSS framework
    'framer-motion@12.34.0'                               // Animation library
  ],
  devDeps: [
    '@types/node@24.9.0',              // Node.js types
    '@types/react@19.2.13',            // React types
    '@types/react-dom@19.2.3',         // React DOM types
    '@tailwindcss/postcss@4.1.18',     // Tailwind PostCSS plugin
    'autoprefixer@10.4.24',            // CSS autoprefixer
    'postcss@8.5.6',                   // CSS post-processor
    `typescript@${typescriptVersion}`   // TypeScript compiler
  ]
})

/**
 * Add npm scripts for the frontend application.
 * Docker scripts follow the same pattern as other services.
 */
frontend.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-frontend}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-frontend}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-frontend}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-frontend}:$(jq -r .version package.json)'
});

// =============================================================================
// Quota Service - Resource quota management
// =============================================================================
/**
 * Quota service (quota)
 *
 * Manages resource quotas and usage limits for organizations:
 *
 * - GET /quota/:orgId - Retrieve quota information
 * - POST /quota/:orgId - Update quota limits (admin only)
 * - Quota enforcement for pipelines, plugins, and other resources
 * - MongoDB for quota storage and tracking
 *
 * Other services call this service to check quotas before creating resources.
 *
 * Quota Types:
 * - PIPELINES: Maximum number of pipelines per organization
 * - PLUGINS: Maximum number of custom plugins per organization
 *
 * @dependency api-core - Shared API utilities
 * @dependency api-server - Express infrastructure
 * @dependency pipeline-core - Configuration
 * @dependency express - Web framework
 * @dependency cors - CORS middleware
 * @dependency express-rate-limit - Rate limiting
 * @dependency helmet - Security headers
 * @dependency jsonwebtoken - JWT authentication
 * @dependency mongoose - MongoDB ODM for quota data
 * @dependency winston - Structured logging
 */
let quota = new FunctionProject({
  parent: root,
  name: 'quota',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/api-core@${apiCoreVersion}`,           // API utilities
    `@mwashburn160/api-server@${apiServerVersion}`,       // Express infrastructure
    `@mwashburn160/pipeline-core@${pipelineCoreVersion}`, // Configuration
    `express@${expressVersion}`,                          // Web framework
    'cors@2.8.6',                                         // CORS
    'express-rate-limit@8.2.1',                           // Rate limiting
    'helmet@8.1.0',                                       // Security
    'jsonwebtoken@9.0.3',                                 // JWT auth
    'mongoose@8.15.1',                                    // MongoDB ODM
    'winston@3.17.0'                                      // Logging
  ],
  devDeps: [
    '@types/express@5.0.6',       // Express types
    '@types/jsonwebtoken@9.0.10', // JWT types
    '@types/cors@2.8.19',         // CORS types
    '@types/node@25.0.6',         // Node.js types
    '@jest/globals@30.2.0'        // Jest testing
  ]
});

/**
 * Add npm scripts for the quota service.
 */
quota.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-quota}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-quota}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-quota}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-quota}:$(jq -r .version package.json)'
});
// Disable problematic ESLint rules
quota.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

// =============================================================================
// Plugin Service - Plugin upload and management
// =============================================================================
/**
 * Plugin service (plugin)
 *
 * Manages custom plugins for CI/CD pipelines:
 *
 * - POST /plugins - Upload and register a new plugin (multipart/form-data)
 * - GET /plugins - List plugins with filtering and pagination
 * - PUT /plugins/:id - Update plugin metadata
 * - DELETE /plugins/:id - Delete a plugin (soft delete)
 *
 * Features:
 * - Plugin manifest validation (YAML)
 * - Docker image building and pushing to registry
 * - Quota enforcement (checks with quota service)
 * - Organization-based access control
 * - PostgreSQL storage via pipeline-data
 *
 * @dependency api-core - Shared API utilities
 * @dependency api-server - Express infrastructure
 * @dependency pipeline-core - Configuration and database
 * @dependency express - Web framework
 * @dependency express-rate-limit - Rate limiting
 * @dependency jsonwebtoken - JWT authentication
 * @dependency helmet - Security headers
 * @dependency cors - CORS middleware
 * @dependency pg - PostgreSQL client
 * @dependency drizzle-orm - PostgreSQL ORM
 * @dependency uuid - UUID generation
 * @dependency yaml - Manifest parsing
 * @dependency adm-zip - Plugin archive extraction
 * @dependency multer - File upload handling
 */
let plugin = new FunctionProject({
  parent: root,
  name: 'plugin',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/api-core@${apiCoreVersion}`,           // API utilities
    `@mwashburn160/api-server@${apiServerVersion}`,       // Express infrastructure
    `@mwashburn160/pipeline-core@${pipelineCoreVersion}`, // Config + database
    `express@${expressVersion}`,                          // Web framework
    'express-rate-limit@8.2.1',                           // Rate limiting
    'jsonwebtoken@9.0.3',                                 // JWT auth
    'helmet@8.1.0',                                       // Security
    'cors@2.8.6',                                         // CORS
    'pg@8.16.3',                                          // PostgreSQL
    'drizzle-orm@0.45.1',                                 // PostgreSQL ORM
    'uuid@13.0.0',                                        // UUID generation
    'yaml@2.8.2',                                         // YAML parsing
    'adm-zip@0.5.16',                                     // ZIP extraction
    'multer@2.0.2'                                        // File uploads
  ],
  devDeps: [
    '@types/express@5.0.6',       // Express types
    '@types/jsonwebtoken@9.0.10', // JWT types
    '@types/cors@2.8.19',         // CORS types
    '@types/node@25.0.6',         // Node.js types
    '@types/pg@8.16.0',           // PostgreSQL types
    '@types/adm-zip@0.5.7',       // ADM-ZIP types
    '@types/multer@2.0.0',        // Multer types
    '@jest/globals@30.2.0'        // Jest testing
  ]
});

/**
 * Add npm scripts for the plugin service.
 */
plugin.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-plugin}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-plugin}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-plugin}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-plugin}:$(jq -r .version package.json)'
});
// Disable problematic ESLint rules
plugin.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

// =============================================================================
// Pipeline Service - Pipeline creation and management
// =============================================================================
/**
 * Pipeline service (pipeline)
 *
 * Manages CI/CD pipeline configurations and metadata:
 *
 * - POST /pipelines - Create a new pipeline
 * - GET /pipelines - List pipelines with filtering and pagination
 * - PUT /pipelines/:id - Update pipeline configuration
 * - DELETE /pipelines/:id - Delete a pipeline (soft delete)
 *
 * Features:
 * - Pipeline metadata storage (name, description, configuration)
 * - YAML configuration validation
 * - Quota enforcement (checks with quota service)
 * - Organization-based access control
 * - PostgreSQL storage via pipeline-data
 * - Real-time updates via SSE
 *
 * Pipelines reference plugins and are deployed to AWS CodePipeline
 * via the pipeline-manager CLI tool.
 *
 * @dependency api-core - Shared API utilities
 * @dependency api-server - Express infrastructure (includes SSE)
 * @dependency pipeline-core - Configuration and database
 * @dependency express - Web framework
 * @dependency express-rate-limit - Rate limiting
 * @dependency jsonwebtoken - JWT authentication
 * @dependency helmet - Security headers
 * @dependency cors - CORS middleware
 * @dependency pg - PostgreSQL client
 * @dependency drizzle-orm - PostgreSQL ORM
 * @dependency uuid - UUID generation
 * @dependency yaml - Configuration parsing
 */
let pipeline = new FunctionProject({
  parent: root,
  name: 'pipeline',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/api-core@${apiCoreVersion}`,           // API utilities
    `@mwashburn160/api-server@${apiServerVersion}`,       // Express + SSE
    `@mwashburn160/pipeline-core@${pipelineCoreVersion}`, // Config + database
    `express@${expressVersion}`,                          // Web framework
    'express-rate-limit@8.2.1',                           // Rate limiting
    'jsonwebtoken@9.0.3',                                 // JWT auth
    'helmet@8.1.0',                                       // Security
    'cors@2.8.6',                                         // CORS
    'pg@8.16.3',                                          // PostgreSQL
    'drizzle-orm@0.45.1',                                 // PostgreSQL ORM
    'uuid@13.0.0',                                        // UUID generation
    'yaml@2.8.2'                                          // YAML parsing
  ],
  devDeps: [
    '@types/express@5.0.6',       // Express types
    '@types/jsonwebtoken@9.0.10', // JWT types
    '@types/cors@2.8.19',         // CORS types
    '@types/node@25.0.6',         // Node.js types
    '@types/pg@8.16.0',           // PostgreSQL types
    '@jest/globals@30.2.0'        // Jest testing
  ]
});

/**
 * Add npm scripts for the pipeline service.
 */
pipeline.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-pipeline}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-pipeline}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-pipeline}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-pipeline}:$(jq -r .version package.json)'
});
// Disable problematic ESLint rules
pipeline.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

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
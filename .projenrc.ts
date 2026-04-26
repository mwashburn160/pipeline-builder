// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @stylistic/max-len */
import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { TypeScriptProject } from 'projen/lib/typescript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { ManagerProject } from './projenrc/manager';
import { FrontEndProject } from './projenrc/frontend';
import { FunctionProject } from './projenrc/function';
import { PackageProject } from './projenrc/package';

// =============================================================================
// Version Constants
// =============================================================================

const branch = 'main';
const pnpmVersion = '10.25.0';
const constructsVersion = '10.5.1';
const typescriptVersion = '5.9.3';
const cdkVersion = '2.240.0';
const expressVersion = '5.2.1';

// Internal package versions — use workspace:* so pnpm resolves from local workspace
const ws = 'workspace:*';
const pkg = {
  apiCore:        '3.3.2',
  pipelineData:   '3.3.2',
  pipelineCore:   '3.3.2',
  apiServer:      ws,
  aiCore:         ws,
  eventBridge:    ws
};

// =============================================================================
// Root Project
// =============================================================================

const root = new TypeScriptProject({
  name: 'root',
  defaultReleaseBranch: branch,
  projenVersion: '0.99.8',
  minNodeVersion: '24.14.0',
  minMajorVersion: 3,
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  depsUpgrade: true,
  typescriptVersion: typescriptVersion,
  gitignore: ['.DS_Store', '.nx', '.lock', '.next', '.vscode', 'dist', 'test-reports', 'db-data', 'pgadmin-data', 'registry-data', '.aws-sam', 'deploy/**/.env', 'image.tar', 'plugin.zip'],
  licensed: true,
  projenrcTs: true,
  jest: false,
  eslint: false,
  buildWorkflow: false,
  release: false,
  sampleCode: false,
  srcdir: 'projenrc',
  devDeps: [
    '@swc-node/core@1.14.1',
    '@swc-node/register@1.11.1',
    `constructs@${constructsVersion}`,
    'npm-check-updates@19.3.2',
  ],
});
root.addScripts({ 'npm-check': 'npx npm-check-updates' });

// All internal packages publish to npmjs.org under @pipeline-builder scope
root.npmrc.addConfig('@pipeline-builder:registry', 'https://registry.npmjs.org/');

// After running 'pnpm dlx projen', fix workspace references:
// find . -name package.json -not -path '*/node_modules/*' -not -path '*/.projen/*' | \
//   xargs sed -E -i 's/"@pipeline-builder\/([^"]+)": "[0-9]+\.[0-9]+\.[0-9]+"/"@pipeline-builder\/\1": "workspace:*"/g'

// =============================================================================
// Shared Defaults & Helpers
// =============================================================================

const baseDefaults = {
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion,
};

const pkgDefaults = {
  ...baseDefaults,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
};

const rules: Record<string, string> = {
  '@stylistic/max-len': 'off',
  'import/no-extraneous-dependencies': 'off',
  '@typescript-eslint/member-ordering': 'off',
};

// Shared npm keywords applied to every @pipeline-builder/* package for search discoverability
const keywords = [
  'aws', 'codepipeline', 'codebuild', 'cicd', 'ci-cd', 'devops',
  'cdk', 'aws-cdk', 'cloudformation', 'pipeline', 'pipeline-as-code',
  'containerized', 'docker', 'kubernetes', 'plugins', 'typescript',
  'self-service', 'multi-tenant', 'compliance', 'automation',
  'infrastructure-as-code', 'iac', 'cli',
];
const homepage = 'https://mwashburn160.github.io/pipeline-builder/';
const bugs = { url: 'https://github.com/mwashburn160/pipeline-builder/issues' };

/** Apply the common npm metadata (keywords, homepage, bugs, license) to a projen package. */
function addPackageMetadata(
  p: { package: { addField: (k: string, v: unknown) => void } },
  description: string,
) {
  p.package.addField('description', description);
  p.package.addField('keywords', keywords);
  p.package.addField('homepage', homepage);
  p.package.addField('bugs', bugs);
}

/**
 * Configure jest for ESM compatibility.
 * uuid v13+ ships ESM-only; we map it to a CJS stub so jest can import it.
 */
function configureJest(project: { jest?: { config: Record<string, unknown> } }, opts?: { maxWorkers?: number }) {
  if (!project.jest) return;
  // Stub uuid with a simple CJS module that returns random strings
  project.jest.config.moduleNameMapper = {
    '^uuid$': '<rootDir>/../../jest-uuid-stub.js',
  };
  if (opts?.maxWorkers) project.jest.config.maxWorkers = opts.maxWorkers;
}

function dockerScripts(name: string, targets?: string[]) {
  const scripts: Record<string, string> = { 'start': 'node lib/index.js' };

  if (targets && targets.length > 0) {
    // Multi-target: only publish target-suffixed tags (e.g., 1.41.6-podman, 1.41.6-kaniko)
    const buildCmds = targets.map(t => {
      const suffix = t.replace(/-target$/, '');
      return `docker buildx build --no-cache --pull --load --target ${t} --build-arg WORKSPACE=\${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t \${PROJECT_NAME:-${name}}:$(jq -r .version package.json)-${suffix} .`;
    });
    const tagCmds = targets.map(t => {
      const suffix = t.replace(/-target$/, '');
      return `docker image tag \${PROJECT_NAME:-${name}}:$(jq -r .version package.json)-${suffix} \${REGISTRY:-ghcr.io/mwashburn160}/\${PROJECT_NAME:-${name}}:$(jq -r .version package.json)-${suffix}`;
    });
    const pushCmds = targets.map(t => {
      const suffix = t.replace(/-target$/, '');
      return `docker push \${REGISTRY:-ghcr.io/mwashburn160}/\${PROJECT_NAME:-${name}}:$(jq -r .version package.json)-${suffix}`;
    });
    scripts['docker:build'] = buildCmds.join(' && ');
    scripts['docker:tag'] = tagCmds.join(' && ');
    scripts['docker:push'] = pushCmds.join(' && ');
  } else {
    // Single target: standard build/tag/push
    scripts['docker:build'] = `docker buildx build --no-cache --pull --load\${BUILD_TARGET:+ --target $BUILD_TARGET} --build-arg WORKSPACE=\${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t \${PROJECT_NAME:-${name}}:$(jq -r .version package.json) .`;
    scripts['docker:tag'] = `docker image tag \${PROJECT_NAME:-${name}}:$(jq -r .version package.json) \${REGISTRY:-ghcr.io/mwashburn160}/\${PROJECT_NAME:-${name}}:$(jq -r .version package.json)`;
    scripts['docker:push'] = `docker push \${REGISTRY:-ghcr.io/mwashburn160}/\${PROJECT_NAME:-${name}}:$(jq -r .version package.json)`;
  }
  return scripts;
}

// Common deps shared by all FunctionProject API services
const commonServiceDeps = [
  `@pipeline-builder/api-core@${pkg.apiCore}`,
  `@pipeline-builder/api-server@${pkg.apiServer}`,
  `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
  `express@${expressVersion}`,
];
const commonServiceDevDeps = [
  '@types/express@5.0.6',
  '@types/node@25.3.0',
  '@jest/globals@30.2.0',
];

// =============================================================================
// Packages
// =============================================================================

// -- API Core --
const apiCore = new PackageProject({
  ...pkgDefaults, parent: root,
  name: '@pipeline-builder/api-core',
  outdir: './packages/api-core',
  deps: [
    `express@${expressVersion}`,
    'jsonwebtoken@9.0.3', 'winston@3.19.0', 'zod@4.3.6',
    '@asteasolutions/zod-to-openapi@8.4.0',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/jsonwebtoken@9.0.10',
    '@types/node@25.3.0', `typescript@${typescriptVersion}`,
  ],
});
apiCore.eslint?.addRules({ ...rules, '@typescript-eslint/no-shadow': 'off' });
addPackageMetadata(apiCore, 'Core server-side utilities (auth middleware, response helpers, error codes, quota service, HTTP client, logging, AI provider catalog) shared by every Pipeline Builder backend service.');
configureJest(apiCore);

// -- Pipeline Data --
const pipelineData = new PackageProject({
  ...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-data',
  outdir: './packages/pipeline-data',
  deps: [`@pipeline-builder/api-core@${pkg.apiCore}`, 'pg@8.18.0', 'drizzle-orm@0.45.1'],
  devDeps: ['@types/node@25.3.0', '@types/pg@8.16.0', 'drizzle-kit@0.31.9', `typescript@${typescriptVersion}`],
});
pipelineData.eslint?.addRules(rules);
addPackageMetadata(pipelineData, 'Database layer for Pipeline Builder: Drizzle ORM schemas, connection management, query builders, and the generic CrudService base class with multi-tenant access control.');
configureJest(pipelineData);

// -- Pipeline Core --
const pipelineCore = new PackageProject({
  ...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-core',
  outdir: './packages/pipeline-core',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
    `constructs@${constructsVersion}`, `aws-cdk-lib@${cdkVersion}`,
    'jsonwebtoken@9.0.3', 'axios@1.13.5', 'uuid@13.0.0',
  ],
  devDeps: [
    '@types/node@25.3.0', '@types/aws-lambda@8.10.160', '@types/jsonwebtoken@9.0.10',
    '@aws-sdk/client-secrets-manager@3.997.0', '@jest/globals@30.2.0', 'copyfiles@2.4.1',
  ],
});
pipelineCore.eslint?.addRules(rules);
pipelineCore.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(pipelineCore, 'AWS CDK construct library for Pipeline Builder: the Builder construct that assembles plugin specs into a CodePipeline stack, PluginLookup custom resource, pipeline/plugin domain types, and shared configuration.');
configureJest(pipelineCore, { maxWorkers: 1 });
pipelineCore.postCompileTask.exec('copyfiles -f ./pnpm-lock.yaml lib/handlers/ --verbose --error');

// -- API Server --
const apiServer = new PackageProject({
  ...pkgDefaults, parent: root,
  name: '@pipeline-builder/api-server',
  outdir: './packages/api-server',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1', 'helmet@8.1.0', 'cors@2.8.6', 'compression@1.8.0',
    'jsonwebtoken@9.0.3', 'uuid@13.0.0', 'prom-client@15.1.3',
    'swagger-ui-express@5.0.1', 'ioredis@5.6.1', 'rate-limit-redis@4.2.0',
    '@opentelemetry/sdk-node@0.213.0', '@opentelemetry/exporter-trace-otlp-http@0.213.0',
    '@opentelemetry/resources@2.6.0', '@opentelemetry/auto-instrumentations-node@0.67.1',
    '@opentelemetry/api@1.9.0',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/express-serve-static-core@5.1.1',
    '@types/compression@1.7.5', '@types/cors@2.8.19', '@types/jsonwebtoken@9.0.10',
    '@types/swagger-ui-express@4.1.8', '@types/node@25.3.0', `typescript@${typescriptVersion}`,
  ],
});
apiServer.eslint?.addRules({ ...rules, 'import/no-unresolved': 'off' });
addPackageMetadata(apiServer, 'Express server infrastructure for Pipeline Builder: app factory, middleware (CORS, Helmet, rate limiting, idempotency, ETag), request context, route wrappers, health-check helpers, and SSE support.');
configureJest(apiServer, { maxWorkers: 1 });

// -- AI Core --
const aiCore = new PackageProject({
  ...pkgDefaults, parent: root,
  name: '@pipeline-builder/ai-core',
  outdir: './packages/ai-core',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    'ai@6.0.99',
    '@ai-sdk/anthropic@3.0.47', '@ai-sdk/openai@3.0.31', '@ai-sdk/google@3.0.31',
    '@ai-sdk/xai@3.0.59', '@ai-sdk/amazon-bedrock@4.0.64', '@ai-sdk/openai-compatible@2.0.31',
  ],
  devDeps: ['@types/node@25.3.0', `typescript@${typescriptVersion}`],
});
aiCore.eslint?.addRules(rules);
addPackageMetadata(aiCore, 'Shared AI provider registry for Pipeline Builder: lazily initialized SDK wrappers for Anthropic, OpenAI, Google, xAI, and Bedrock used by AI-assisted pipeline and plugin generation.');
configureJest(aiCore);

// -- EventBridge Lambda --
const eventBridge = new PackageProject({
  ...pkgDefaults, parent: root,
  name: '@pipeline-builder/event-bridge',
  outdir: './packages/event-bridge',
  deps: [],
  devDeps: [
    '@types/node@25.3.0', '@types/aws-lambda@8.10.160',
    '@aws-sdk/client-secrets-manager@3.997.0', `typescript@${typescriptVersion}`,
  ],
});
eventBridge.eslint?.addRules(rules);
addPackageMetadata(eventBridge, 'AWS Lambda handler for Pipeline Builder that ingests CodePipeline state-change events from EventBridge and forwards normalized payloads to the reporting service.');
configureJest(eventBridge);

// =============================================================================
// Pipeline Manager CLI
// =============================================================================

const manager = new ManagerProject({
  ...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-manager',
  outdir: './packages/pipeline-manager',
  bin: { 'pipeline-manager': './dist/cli.js' },
  deps: [
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    `typescript@${typescriptVersion}`, `aws-cdk-lib@${cdkVersion}`,
    '@aws-sdk/client-cloudformation@3.821.0', '@aws-sdk/client-lambda@3.821.0',
    '@aws-sdk/client-secrets-manager@3.821.0', '@aws-sdk/client-sts@3.821.0',
    'form-data@4.0.5', 'commander@14.0.3', 'figlet@1.10.0',
    'axios@1.13.5', 'progress@2.0.3', 'picocolors@1.1.1', 'yaml@2.8.2', 'ora@9.3.0',
  ],
  devDeps: ['@types/figlet@1.7.0', '@types/progress@2.0.7', 'copyfiles@2.4.1'],
});
manager.eslint?.addRules({ ...rules, '@typescript-eslint/no-shadow': 'off' });
manager.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(manager, 'CLI for Pipeline Builder — self-service AWS CodePipeline platform with 124 reusable containerized plugins, per-org compliance enforcement, and multi-tenant isolation.');
manager.addPackageIgnore('/dist/js/');
manager.postCompileTask.exec('copyfiles -f ./cdk.json dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./config.yml dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./src/templates/*.json dist/templates/ --verbose --error');
manager.addTask('audit', { exec: 'pnpm audit --audit-level=high', description: 'Check for known vulnerabilities in dependencies' });
configureJest(manager);

// =============================================================================
// Platform Service
// =============================================================================

const platform = new FunctionProject({
  ...baseDefaults, parent: root,
  name: 'platform',
  outdir: './platform',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `express@${expressVersion}`, 'express-rate-limit@8.2.1',
    'nodemailer@8.0.1', 'zod@4.3.6', '@aws-sdk/client-sesv2@3.997.0',
    'jsonwebtoken@9.0.3', 'slugify@1.6.6', 'winston@3.19.0', 'bcryptjs@3.0.3',
    'mongoose@9.2.2', 'helmet@8.1.0', 'cors@2.8.6',
    'pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'yaml@2.8.2',
    'adm-zip@0.5.16', 'multer@2.0.2', 'prom-client@15.1.3',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/express-serve-static-core@5.1.1',
    '@types/nodemailer@7.0.11', '@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19',
    '@types/node@25.3.0', '@types/pg@8.16.0', '@types/adm-zip@0.5.7',
    '@types/multer@2.0.0', '@jest/globals@30.2.0', 'copyfiles@2.4.1',
  ],
});
platform.postCompileTask.exec('copyfiles -f ./src/utils/email-templates/*.html lib/utils/email-templates/ --verbose --error');
platform.addScripts(dockerScripts('platform'));
platform.eslint?.addRules(rules);
configureJest(platform);

// =============================================================================
// Frontend
// =============================================================================

const frontend = new FrontEndProject({
  ...baseDefaults, parent: root,
  name: 'frontend',
  outdir: './frontend',
  gitignore: ['.DS_Store', 'yarn.lock', '.next', '.vscode', 'dist'],
  jest: true,
  jestOptions: {
    jestConfig: {
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
    },
  },
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/api-server@${pkg.apiServer}`,
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    'next@16.1.6', 'react@19.2.4', 'react-dom@19.2.4',
    'lucide-react@0.575.0', 'tailwindcss@4.2.1', 'framer-motion@12.34.3', 'swr@2.3.3',
  ],
  devDeps: [
    '@types/node@25.3.0', '@types/react@19.2.14', '@types/react-dom@19.2.3',
    '@tailwindcss/postcss@4.2.1', 'autoprefixer@10.4.24',
    'postcss@8.5.6', 'ts-jest@^29.4.6', `typescript@${typescriptVersion}`,
  ],
});
configureJest(frontend);
if (frontend.jest) {
  frontend.jest.config.transform = { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] };
  frontend.jest.config.moduleNameMapper = {
    ...frontend.jest.config.moduleNameMapper as Record<string, string>,
    '^@/(.*)$': '<rootDir>/src/$1',
  };
}
frontend.addScripts(dockerScripts('frontend'));

// =============================================================================
// API Services (data-driven)
// =============================================================================

const services: Array<{ name: string; deps: string[]; devDeps?: string[] }> = [
  {
    name: 'quota',
    deps: ['cors@2.8.6', 'express-rate-limit@8.2.1', 'helmet@8.1.0', 'jsonwebtoken@9.0.3', 'mongoose@9.2.2', 'winston@3.19.0', 'zod@4.3.6'],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19'],
  },
  {
    name: 'billing',
    deps: [
      'cors@2.8.6', 'express-rate-limit@8.2.1', 'helmet@8.1.0', 'jsonwebtoken@9.0.3', 'mongoose@9.2.2', 'winston@3.19.0', 'zod@4.3.6',
      '@aws-sdk/client-marketplace-metering@3.997.0', '@aws-sdk/client-marketplace-entitlement-service@3.997.0', 'stripe@17.7.0',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19'],
  },
  {
    name: 'plugin',
    deps: [
      'express-rate-limit@8.2.1', 'jsonwebtoken@9.0.3', 'helmet@8.1.0', 'cors@2.8.6',
      'pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'yaml@2.8.2',
      'adm-zip@0.5.16', 'yauzl@3.3.0', 'multer@2.0.2', `@pipeline-builder/ai-core@${pkg.aiCore}`, 'zod@4.3.6',
      'bullmq@5.34.8', 'ioredis@5.6.1',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19', '@types/pg@8.16.0', '@types/adm-zip@0.5.7', '@types/yauzl@2.10.3', '@types/multer@2.0.0'],
  },
  {
    name: 'pipeline',
    deps: [
      'express-rate-limit@8.2.1', 'jsonwebtoken@9.0.3', 'helmet@8.1.0', 'cors@2.8.6',
      'pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'yaml@2.8.2',
      `@pipeline-builder/ai-core@${pkg.aiCore}`, 'zod@4.3.6',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19', '@types/pg@8.16.0'],
  },
  {
    name: 'message',
    deps: ['pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'ws@8.18.2', 'zod@4.3.6'],
    devDeps: ['@types/pg@8.16.0', '@types/ws@8.18.1'],
  },
  {
    name: 'reporting',
    deps: [`@pipeline-builder/pipeline-data@${pkg.pipelineData}`, 'pg@8.18.0', 'drizzle-orm@0.45.1', 'zod@4.3.6'],
    devDeps: ['@types/pg@8.16.0'],
  },
  {
    name: 'compliance',
    deps: ['pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'zod@4.3.6', 'bullmq@5.34.8'],
    devDeps: ['@types/pg@8.16.0'],
  },
];

for (const svc of services) {
  const project = new FunctionProject({
    ...baseDefaults, parent: root,
    name: svc.name,
    deps: [...commonServiceDeps, ...svc.deps],
    devDeps: [...commonServiceDevDeps, ...(svc.devDeps ?? [])],
  });
  project.addScripts(dockerScripts(svc.name, svc.name === 'plugin' ? ['podman-target', 'kaniko-target', 'docker-target'] : undefined));
  project.eslint?.addRules(rules);
  configureJest(project);
}

// =============================================================================
// Workspace Configuration
// =============================================================================

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });

root.synth();

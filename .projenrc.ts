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

// -- Version constants --
const branch = 'main';
const pnpmVersion = '10.25.0';
const constructsVersion = '10.5.1';
const typescriptVersion = '5.9.3';
const cdkVersion = '2.240.0';
const expressVersion = '5.2.1';

// Internal package versions — use workspace:* for local, or pin e.g. '1.6.6' for npm
//const ws = 'workspace:*';
const pkg = {
  apiCore:        '1.42.11',
  pipelineData:   '1.43.11',
  pipelineCore:   '1.44.10',
  apiServer:      '1.41.12',
  aiCore:         '1.16.10',
  eventIngestion: '1.4.10',
};

// -- Root project --
const root = new TypeScriptProject({
  name: '@mwashburn160/root',
  defaultReleaseBranch: branch,
  projenVersion: '0.99.8',
  minNodeVersion: '24.14.0',
  minMajorVersion: 1,
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  depsUpgrade: true,
  typescriptVersion: typescriptVersion,
  gitignore: ['.DS_Store', '.nx', '.lock', '.next', '.vscode', 'dist', 'test-reports', 'db-data', 'pgadmin-data', 'registry-data', '.aws-sam', 'deploy/**/.env'],
  licensed: true,
  projenrcTs: true,
  jest: false,
  eslint: false,
  buildWorkflow: false,
  release: false,
  sampleCode: false,
  srcdir: 'projenrc',
  npmAccess: NpmAccess.RESTRICTED,
  devDeps: [
    '@swc-node/core@1.14.1',
    '@swc-node/register@1.11.1',
    `constructs@${constructsVersion}`,
    'npm-check-updates@19.3.2',
  ],
});
root.addScripts({ 'npm-check': 'npx npm-check-updates' });

// -- Shared defaults --
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

// -- Docker scripts helper --
function dockerScripts(name: string) {
  return {
    'start': 'node lib/index.js',
    'docker:build': `docker buildx build --no-cache --pull --load --build-arg WORKSPACE=\${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t \${PROJECT_NAME:-${name}}:$(jq -r .version package.json) .`,
    'docker:tag': `docker image tag \${PROJECT_NAME:-${name}}:$(jq -r .version package.json) \${REGISTRY:-ghcr.io/mwashburn160}/\${PROJECT_NAME:-${name}}:$(jq -r .version package.json)`,
    'docker:push': `docker push \${REGISTRY:-ghcr.io/mwashburn160}/\${PROJECT_NAME:-${name}}:$(jq -r .version package.json)`,
  };
}

// -- Shared ESLint overrides (applied to all packages) --
const rules: Record<string, string> = {
  '@stylistic/max-len': 'off',
  'import/no-extraneous-dependencies': 'off',
  '@typescript-eslint/member-ordering': 'off',
};

// -- Common service dependencies (shared by all FunctionProject API services) --
const commonServiceDeps = [
  `@mwashburn160/api-core@${pkg.apiCore}`,
  `@mwashburn160/api-server@${pkg.apiServer}`,
  `@mwashburn160/pipeline-core@${pkg.pipelineCore}`,
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
  ...pkgDefaults,
  parent: root,
  name: '@mwashburn160/api-core',
  outdir: './packages/api-core',
  deps: [
    `express@${expressVersion}`,
    'jsonwebtoken@9.0.3',
    'winston@3.19.0',
    'zod@4.3.6',
    '@asteasolutions/zod-to-openapi@8.4.0',
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/node@25.3.0',
    `typescript@${typescriptVersion}`,
  ],
});
apiCore.eslint?.addRules({ ...rules, '@typescript-eslint/no-shadow': 'off' });

// -- Pipeline Data --
const pipelineData = new PackageProject({
  ...pkgDefaults,
  parent: root,
  name: '@mwashburn160/pipeline-data',
  outdir: './packages/pipeline-data',
  deps: [
    `@mwashburn160/api-core@${pkg.apiCore}`,
    'pg@8.18.0',
    'drizzle-orm@0.45.1',
  ],
  devDeps: [
    '@types/node@25.3.0',
    '@types/pg@8.16.0',
    'drizzle-kit@0.31.9',
    `typescript@${typescriptVersion}`,
  ],
});
pipelineData.eslint?.addRules(rules);

// -- Pipeline Core --
const pipelineCore = new PackageProject({
  ...pkgDefaults,
  parent: root,
  name: '@mwashburn160/pipeline-core',
  outdir: './packages/pipeline-core',
  deps: [
    `@mwashburn160/api-core@${pkg.apiCore}`,
    `@mwashburn160/pipeline-data@${pkg.pipelineData}`,
    `constructs@${constructsVersion}`,
    `aws-cdk-lib@${cdkVersion}`,
    'jsonwebtoken@9.0.3',
    'axios@1.13.5',
    'uuid@13.0.0',
  ],
  devDeps: [
    '@types/node@25.3.0',
    '@types/aws-lambda@8.10.160',
    '@types/jsonwebtoken@9.0.10',
    '@aws-sdk/client-secrets-manager@3.997.0',
    '@jest/globals@30.2.0',
    'copyfiles@2.4.1'
  ],
});
pipelineCore.eslint?.addRules(rules);
if (pipelineCore.jest) {
  pipelineCore.jest.config.maxWorkers = 1;
}
pipelineCore.postCompileTask.exec('copyfiles -f ./pnpm-lock.yaml lib/handlers/ --verbose --error');

// -- API Server --
const apiServer = new PackageProject({
  ...pkgDefaults,
  parent: root,
  name: '@mwashburn160/api-server',
  outdir: './packages/api-server',
  deps: [
    `@mwashburn160/api-core@${pkg.apiCore}`,
    `@mwashburn160/pipeline-core@${pkg.pipelineCore}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'helmet@8.1.0',
    'cors@2.8.6',
    'compression@1.8.0',
    'jsonwebtoken@9.0.3',
    'uuid@13.0.0',
    'prom-client@15.1.3',
    'swagger-ui-express@5.0.1',
    'ioredis@5.6.1',
    'rate-limit-redis@4.2.0',
    '@opentelemetry/sdk-node@0.213.0',
    '@opentelemetry/exporter-trace-otlp-http@0.213.0',
    '@opentelemetry/resources@2.6.0',
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/express-serve-static-core@5.1.1',
    '@types/compression@1.7.5',
    '@types/cors@2.8.19',
    '@types/jsonwebtoken@9.0.10',
    '@types/swagger-ui-express@4.1.8',
    '@types/node@25.3.0',
    `typescript@${typescriptVersion}`,
  ],
});
apiServer.eslint?.addRules({ ...rules, 'import/no-unresolved': 'off' });
if (apiServer.jest) {
  apiServer.jest.config.maxWorkers = 1;
}

// -- AI Core --
const aiCore = new PackageProject({
  ...pkgDefaults,
  parent: root,
  name: '@mwashburn160/ai-core',
  outdir: './packages/ai-core',
  deps: [
    `@mwashburn160/api-core@${pkg.apiCore}`,
    'ai@6.0.99',
    '@ai-sdk/anthropic@3.0.47',
    '@ai-sdk/openai@3.0.31',
    '@ai-sdk/google@3.0.31',
    '@ai-sdk/xai@3.0.59',
    '@ai-sdk/amazon-bedrock@4.0.64',
    '@ai-sdk/openai-compatible@2.0.31',
  ],
  devDeps: [
    '@types/node@25.3.0',
    `typescript@${typescriptVersion}`,
  ],
});
aiCore.eslint?.addRules(rules);

// -- Event Ingestion Lambda --
const eventIngestion = new PackageProject({
  ...pkgDefaults,
  parent: root,
  name: '@mwashburn160/event-ingestion',
  outdir: './packages/event-ingestion',
  deps: [],
  devDeps: [
    '@types/node@25.3.0',
    '@types/aws-lambda@8.10.160',
    '@aws-sdk/client-secrets-manager@3.997.0',
    `typescript@${typescriptVersion}`,
  ],
});
eventIngestion.eslint?.addRules(rules);

// =============================================================================
// Pipeline Manager CLI
// =============================================================================

const manager = new ManagerProject({
  ...pkgDefaults,
  parent: root,
  name: '@mwashburn160/pipeline-manager',
  outdir: './packages/pipeline-manager',
  bin: { 'pipeline-manager': './dist/cli.js' },
  deps: [
    `@mwashburn160/pipeline-core@${pkg.pipelineCore}`,
    `typescript@${typescriptVersion}`,
    `aws-cdk-lib@${cdkVersion}`,
    'form-data@4.0.5',
    'commander@14.0.3',
    'figlet@1.10.0',
    'axios@1.13.5',
    'progress@2.0.3',
    'picocolors@1.1.1',
    'yaml@2.8.2',
    'ora@9.3.0',
  ],
  devDeps: [
    '@types/figlet@1.7.0',
    '@types/progress@2.0.7',
    'copyfiles@2.4.1',
  ],
});
manager.eslint?.addRules({ ...rules, '@typescript-eslint/no-shadow': 'off' });
manager.addPackageIgnore('/dist/js/');
manager.postCompileTask.exec('copyfiles -f ./cdk.json dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./config.yml dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./src/templates/*.json dist/templates/ --verbose --error');

// =============================================================================
// Platform Service
// =============================================================================

const platform = new FunctionProject({
  ...baseDefaults,
  parent: root,
  name: 'platform',
  outdir: './platform',
  deps: [
    `@mwashburn160/api-core@${pkg.apiCore}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'nodemailer@8.0.1',
    'zod@4.3.6',
    '@aws-sdk/client-sesv2@3.997.0',
    'jsonwebtoken@9.0.3',
    'slugify@1.6.6',
    'winston@3.19.0',
    'bcryptjs@3.0.3',
    'mongoose@9.2.2',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.18.0',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0',
    'yaml@2.8.2',
    'adm-zip@0.5.16',
    'multer@2.0.2',
    'prom-client@15.1.3',
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/express-serve-static-core@5.1.1',
    '@types/nodemailer@7.0.11',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.3.0',
    '@types/pg@8.16.0',
    '@types/adm-zip@0.5.7',
    '@types/multer@2.0.0',
    '@jest/globals@30.2.0',
  ],
});
platform.addScripts(dockerScripts('platform'));
platform.eslint?.addRules(rules);

// =============================================================================
// Frontend
// =============================================================================

const frontend = new FrontEndProject({
  ...baseDefaults,
  parent: root,
  name: 'frontend',
  outdir: './frontend',
  gitignore: ['.DS_Store', 'yarn.lock', '.next', '.vscode', 'dist'],
  deps: [
    `@mwashburn160/api-core@${pkg.apiCore}`,
    `@mwashburn160/api-server@${pkg.apiServer}`,
    `@mwashburn160/pipeline-core@${pkg.pipelineCore}`,
    'next@16.1.6',
    'react@19.2.4',
    'react-dom@19.2.4',
    'lucide-react@0.575.0',
    'tailwindcss@4.2.1',
    'framer-motion@12.34.3',
    'swr@2.3.3',
  ],
  devDeps: [
    '@types/node@25.3.0',
    '@types/react@19.2.14',
    '@types/react-dom@19.2.3',
    '@types/jest@^30.0.0',
    '@tailwindcss/postcss@4.2.1',
    'autoprefixer@10.4.24',
    'postcss@8.5.6',
    'jest@^30.2.0',
    'ts-jest@^29.4.6',
    `typescript@${typescriptVersion}`,
  ],
});
frontend.testTask.exec('jest --passWithNoTests --config jest.config.ts');
frontend.addScripts(dockerScripts('frontend'));

// =============================================================================
// API Services (data-driven)
// =============================================================================

const services: Array<{
  name: string;
  deps: string[];
  devDeps?: string[];
}> = [
  {
    name: 'quota',
    deps: [
      'cors@2.8.6', 'express-rate-limit@8.2.1', 'helmet@8.1.0',
      'jsonwebtoken@9.0.3', 'mongoose@9.2.2', 'winston@3.19.0', 'zod@4.3.6',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19'],
  },
  {
    name: 'billing',
    deps: [
      'cors@2.8.6', 'express-rate-limit@8.2.1', 'helmet@8.1.0',
      'jsonwebtoken@9.0.3', 'mongoose@9.2.2', 'winston@3.19.0', 'zod@4.3.6',
      '@aws-sdk/client-marketplace-metering@3.997.0',
      '@aws-sdk/client-marketplace-entitlement-service@3.997.0',
      'stripe@17.7.0',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19'],
  },
  {
    name: 'plugin',
    deps: [
      'express-rate-limit@8.2.1', 'jsonwebtoken@9.0.3', 'helmet@8.1.0', 'cors@2.8.6',
      'pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'yaml@2.8.2',
      'adm-zip@0.5.16', 'multer@2.0.2',
      `@mwashburn160/ai-core@${pkg.aiCore}`, 'zod@4.3.6',
      'bullmq@5.34.8', 'ioredis@5.6.1',
    ],
    devDeps: [
      '@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19',
      '@types/pg@8.16.0', '@types/adm-zip@0.5.7', '@types/multer@2.0.0',
    ],
  },
  {
    name: 'pipeline',
    deps: [
      'express-rate-limit@8.2.1', 'jsonwebtoken@9.0.3', 'helmet@8.1.0', 'cors@2.8.6',
      'pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'yaml@2.8.2',
      `@mwashburn160/ai-core@${pkg.aiCore}`, 'zod@4.3.6',
    ],
    devDeps: [
      '@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19', '@types/pg@8.16.0',
    ],
  },
  {
    name: 'message',
    deps: [
      'pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'zod@4.3.6',
    ],
    devDeps: ['@types/pg@8.16.0'],
  },
  {
    name: 'reporting',
    deps: [
      `@mwashburn160/pipeline-data@${pkg.pipelineData}`,
      'pg@8.18.0', 'drizzle-orm@0.45.1', 'zod@4.3.6',
    ],
    devDeps: ['@types/pg@8.16.0'],
  },
  {
    name: 'compliance',
    deps: [
      'pg@8.18.0', 'drizzle-orm@0.45.1', 'uuid@13.0.0', 'zod@4.3.6',
      'cron-parser@5.0.6', 'bullmq@5.34.8',
    ],
    devDeps: ['@types/pg@8.16.0'],
  },
];

for (const svc of services) {
  const project = new FunctionProject({
    ...baseDefaults,
    parent: root,
    name: svc.name,
    deps: [...commonServiceDeps, ...svc.deps],
    devDeps: [...commonServiceDevDeps, ...(svc.devDeps ?? [])],
  });
  project.addScripts(dockerScripts(svc.name));
  project.eslint?.addRules(rules);
}

// =============================================================================
// Workspace Configuration
// =============================================================================

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });

root.synth();

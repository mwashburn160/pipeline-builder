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
const pnpmVersion = '10.33.0';
const constructsVersion = '10.6.0';
const typescriptVersion = '6.0.3';
const cdkVersion = '2.258.1';
const expressVersion = '5.2.1';

// jest version. Every package is ESM and imports test globals from
// `@jest/globals` (self-typed), so none depend on `@types/jest` — the historical
// ceiling (projen pins `@types/jest` to jestVersion, and `@types/jest` has no
// 30.4.x) no longer applies. See `configureEsmJest` in projenrc/shared-config.ts.
const jestVersion = '30.4.2';

// Internal package versions  `workspace:*` so pnpm always resolves from
// the local workspace. Using a pinned npm version causes pnpm to install
// the published package from the registry, which means schema/API changes
// in one workspace package don't propagate to its consumers in CI until
// after a release. nx release rewrites these to a concrete version at
// publish time, so consumers on npm still get an exact version.
const ws = 'workspace:*';
const pkg = {
  aiCore: ws,
  apiCore: ws,
  apiServer: ws,
  pipelineData: ws,
  pipelineCore: ws,
  pipelineEvents: ws
};

// =============================================================================
// Root Project
// =============================================================================

const root = new TypeScriptProject({
  name: 'root',
  defaultReleaseBranch: branch,
  projenVersion: '0.99.71',
  minNodeVersion: '24.14.0',
  minMajorVersion: 3,
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  depsUpgrade: true,
  typescriptVersion: typescriptVersion,
  gitignore: ['.DS_Store', '.nx', '.lock', '.next', '.vscode', 'dist', 'test-reports', 'db-data', 'pgadmin-data', 'registry-data', '.aws-sam', 'deploy/**/.env', 'image.tar', '.image-hash', 'plugin.zip', '.docker-build/'],
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
    'npm-check-updates@22.2.3',
  ],
});
root.addScripts({ 'npm-check': 'npx npm-check-updates' });

// All internal packages publish to npmjs.org under @pipeline-builder scope
root.npmrc.addConfig('@pipeline-builder:registry', 'https://registry.npmjs.org/');

// Run pnpm workspace recursive operations (install, build, test) one at a
// time. Higher concurrency overlaps docker buildx, registry pushes, and
// per-tier buildkitd warmup in ways that race on shared resources (the same
// Redis DB, the local docker daemon, the same per-org KMS keys); serializing
// trades wall-clock for reliability.
root.npmrc.addConfig('workspace-concurrency', '1');

// =============================================================================
// Shared Defaults & Helpers
// =============================================================================

const baseDefaults = {
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion,
  // Inherited by every subproject; see the `jestVersion` declaration above
  // for the trap this closes. Per-project `jestOptions` overrides must spread
  // this in or they lose the pin.
  jestOptions: { jestVersion },
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

// Shared npm keywords applied to every @pipeline-builder/* package. Ordered by
// search intent: what the platform IS, the AWS stack it builds on, the pipelines
// it produces, its governance/multi-tenancy differentiators, AI generation, and
// the plugin/container model — so the metadata reflects core capabilities, not
// just a generic tech list.
const keywords = [
  // Category & positioning (highest-intent search terms)
  'ci-cd', 'cicd', 'continuous-delivery', 'devops', 'self-service',
  'platform-engineering', 'internal-developer-platform', 'developer-platform',
  // AWS CodePipeline / CDK stack it generates
  'aws', 'aws-cdk', 'cdk', 'codepipeline', 'codebuild', 'cloudformation',
  // Pipelines as code
  'pipeline', 'pipeline-as-code', 'infrastructure-as-code', 'iac',
  // Governance & multi-tenancy (the differentiators)
  'compliance', 'policy-as-code', 'governance', 'golden-paths', 'multi-tenant', 'rbac',
  // AI pipeline generation
  'ai', 'ai-pipeline-generation', 'llm', 'bedrock',
  // Plugin catalog & containerized builds
  'plugins', 'plugin-marketplace', 'containerized', 'docker', 'kubernetes',
  // Implementation
  'typescript', 'cli',
];
const homepage = 'https://mwashburn160.github.io/pipeline-builder/';
const bugs = { url: 'https://github.com/mwashburn160/pipeline-builder/issues' };

/**
 * Apply the common npm metadata (keywords, homepage, bugs, license) to a
 * projen package.
 *
 * Pass `{ private: true }` to mark the package as workspace-only  adds
 * `"private": true` to package.json so `pnpm publish` skips it regardless
 * of how filters resolved. Use for packages that consumers depend on via
 * the workspace but should never appear on the npm registry (e.g. internal
 * SDK wrappers, build-time-only helpers).
 */
function addPackageMetadata(  p: { package: { addField: (k: string, v: unknown) => void } },
  description: string,
  opts: { private?: boolean } = {},
) {
  p.package.addField('description', description);
  p.package.addField('keywords', keywords);
  p.package.addField('homepage', homepage);
  p.package.addField('bugs', bugs);
  if (opts.private) p.package.addField('private', true);
}

// Per-image package descriptions surfaced on the registry (GHCR) package page.
// SINGLE source of truth: emitted as the index-level org.opencontainers.image.description
// annotation in docker:publish (below). A Dockerfile LABEL only sets the per-arch image
// config, which GHCR doesn't surface for a manifest list, so those were removed. Keyed by
// project name.
const IMAGE_DESCRIPTIONS: Record<string, string> = {
  platform: 'Pipeline Builder platform service — authentication, organizations, users, and admin APIs.',
  frontend: 'Pipeline Builder web UI.',
  quota: 'Pipeline Builder quota service — per-org usage quotas and metering.',
  billing: 'Pipeline Builder billing service — subscriptions, usage metering, and Stripe/marketplace billing.',
  plugin: 'Pipeline Builder plugin service — plugin upload, BuildKit image builds, and registry publishing.',
  pipeline: 'Pipeline Builder pipeline service — pipeline CRUD and CDK pipeline synthesis.',
  message: 'Pipeline Builder message service — in-app notifications and messaging.',
  reporting: 'Pipeline Builder reporting service — dashboards, metrics, and reporting.',
  compliance: 'Pipeline Builder compliance service — policy rules, plugin/pipeline validation, exemptions, and scans.',
  'image-registry': 'Pipeline Builder image-registry service — Docker registry token authorization for plugin images.',
};

function dockerScripts(name: string) {
  const version = '$(jq -r .version package.json)';

  // Shared build-context staging. CRITICAL: `nx run-many -t build --with-deps`
  // recompiles every workspace dep (api-core, api-server, pipeline-core,
  // pipeline-data) BEFORE `pnpm deploy` stages the self-contained tree at
  // ./.docker-build/. Without it, pnpm deploy copies whatever stale lib/ is on
  // disk and the image silently diverges from source. The Dockerfile copies
  // that tree as-is (no in-Docker npm install to drift on caret ranges). The
  // --legacy flag deep-copies workspace internal deps; --prod skips devDeps.
  // Nx caches the no-op case so unchanged builds stay fast.
  const stage = [
    `pnpm nx run-many -t build --projects=${name} --with-deps`,
    'rm -rf .docker-build',
    `pnpm deploy --filter ${name} --prod --legacy .docker-build`,
  ];
  // Common buildx flags; each task appends the ` .` build-context path. The
  // `status=$?; rm -rf .docker-build; exit $status` tail keeps the cleanup
  // running on buildx failure while propagating buildx's real exit code (a
  // `;`-joined `rm` would otherwise mask docker errors as success).
  //
  // --pull (not --no-cache): the staged ./.docker-build tree is content-hashed
  // by buildx, so layer cache stays correct while --pull keeps the base image
  // fresh — dropping --no-cache lets the (slow, emulated) arm64 leg reuse
  // layers. --provenance=false keeps the pushed manifest a clean 2-entry list
  // (default buildx provenance adds an `unknown/unknown` attestation entry).
  const buildxCommon = `--pull --provenance=false --build-arg WORKSPACE=\${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig)`;
  // Registry-backed layer cache, enabled only when DOCKER_CACHE is set (CI), so
  // a local `docker:publish` doesn't fail on the GHA-only cache backend. Scoped
  // per-project so images don't collide in the shared cache.
  const cacheFlags = `\${DOCKER_CACHE:+--cache-from type=gha,scope=\${PROJECT_NAME:-${name}} --cache-to type=gha,mode=max,scope=\${PROJECT_NAME:-${name}}}`;
  const localTag = `\${PROJECT_NAME:-${name}}:${version}`;
  const registryRef = `\${REGISTRY:-ghcr.io/mwashburn160}/\${PROJECT_NAME:-${name}}:${version}`;
  const cleanup = ['status=$?', 'rm -rf .docker-build', 'exit $status'];

  // GHCR shows the package "Description" from the `org.opencontainers.image.description`
  // annotation on the pushed image INDEX (the manifest list). A Dockerfile LABEL only
  // sets the per-arch image *config*, which GHCR does NOT surface for a manifest list —
  // which is why the labelled images still read "No description provided". Emit it as an
  // index-level buildx annotation on docker:publish so the description lands on the page.
  const description = IMAGE_DESCRIPTIONS[name];
  const descAnnotation = description
    ? `--annotation "index:org.opencontainers.image.description=${description}" `
    : '';

  return {
    // --import preloads the otel bootstrap for dev parity with the Dockerfile CMD
    // (a no-op unless OTEL_TRACING_ENABLED=true). Frontend's start is vestigial (Next).
    'start': 'node --import @pipeline-builder/api-server/lib/otel-bootstrap.js lib/index.js',
    // Local SINGLE-ARCH build → loads into the local docker daemon for fast dev
    // iteration (builds for the host arch). Multi-arch can't use --load (the
    // daemon has no manifest-list store); CI uses docker:publish instead.
    'docker:build': [
      ...stage,
      `docker buildx build ${buildxCommon} --load -t ${localTag} .`,
      ...cleanup,
    ].join('; '),
    'docker:tag': `docker image tag ${localTag} ${registryRef}`,
    'docker:push': `docker push ${registryRef}`,
    // MULTI-ARCH publish (CI): build a manifest list for all DOCKER_PLATFORMS and
    // push it in ONE step. --push (not --load) is mandatory — buildx assembles +
    // uploads the OCI index directly. Each non-native arch is an emulated (QEMU)
    // build leg, so CI must set up QEMU (see release.yml). Override
    // DOCKER_PLATFORMS to narrow to one arch or add more.
    'docker:publish': [
      ...stage,
      `docker buildx build ${buildxCommon} ${descAnnotation}${cacheFlags} --platform \${DOCKER_PLATFORMS:-linux/amd64,linux/arm64} -t ${registryRef} --push .`,
      ...cleanup,
    ].join('; '),
    // REAL multi-arch gate: assert the published tag is a manifest list that
    // contains BOTH amd64 and arm64. Use `--raw` (the raw index/manifest JSON,
    // lowercase keys) rather than a Go `--format` template — `{{json .Manifest.manifests}}`
    // fails to evaluate `.manifests` on the template's interface{} value. jq does
    // all the work: `(.manifests // [])` is [] for a single-arch image, so it
    // fails cleanly (exit non-zero) instead of erroring. `jq -e` exits non-zero
    // when the result is false/null. DOCKER_PLATFORMS-narrowed builds should
    // override this check.
    'docker:verify': `docker buildx imagetools inspect ${registryRef} --raw | jq -e '[(.manifests // [])[].platform.architecture] as $a | (($a | index("amd64")) and ($a | index("arm64")))'`,
  };
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
  '@types/node@25.9.2',
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
    'jsonwebtoken@9.0.3', 'winston@3.19.0', 'zod@4.4.3',
    '@asteasolutions/zod-to-openapi@8.5.0',
    // AWS-KMS KeyProvider  bundled as a regular dep so the
    // KmsKeyProvider class can be imported without operator-side install
    // steps. Lazy-loaded at first use; envs that stick with the
    // EnvKeyProvider don't construct a KMS client.
    '@aws-sdk/client-kms@3.1064.0',
    // STS + credential-providers for the per-org IAM role assumption
    // helper. Same posture as the KMS client: lazy-imported, only loads
    // when an operator configures a per-org assumeRoleArn.
    '@aws-sdk/client-sts@3.1064.0',
    '@aws-sdk/credential-providers@3.1064.0',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/jsonwebtoken@9.0.10',
    '@types/node@25.9.2', `typescript@${typescriptVersion}`,
  ],
});
apiCore.eslint?.addRules({...rules, '@typescript-eslint/no-shadow': 'off' });
apiCore.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(apiCore, 'Core server-side utilities (auth middleware, response helpers, error codes, quota service, HTTP client, logging, AI provider catalog) shared by every Pipeline Builder backend service.');

// -- Pipeline Data --
const pipelineData = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-data',
  outdir: './packages/pipeline-data',
  deps: [`@pipeline-builder/api-core@${pkg.apiCore}`, 'pg@8.21.0', 'drizzle-orm@0.45.2'],
  devDeps: ['@types/node@25.9.2', '@types/pg@8.20.0', 'drizzle-kit@0.31.10', `typescript@${typescriptVersion}`],
});
pipelineData.eslint?.addRules(rules);
pipelineData.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(pipelineData, 'Database layer for Pipeline Builder: Drizzle ORM schemas, connection management, query builders, and the generic CrudService base class with per-organization (and team) access control.');

// -- Pipeline Core --
const pipelineCore = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-core',
  outdir: './packages/pipeline-core',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
    `constructs@${constructsVersion}`, `aws-cdk-lib@${cdkVersion}`,
    'jsonwebtoken@9.0.3', 'axios@1.17.0', 'uuid@14.0.0',
  ],
  devDeps: [
    '@types/node@25.9.2', '@types/aws-lambda@8.10.162', '@types/jsonwebtoken@9.0.10',
    '@aws-sdk/client-secrets-manager@3.1064.0', 'copyfiles@2.4.1',
  ],
});
pipelineCore.eslint?.addRules(rules);
pipelineCore.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(pipelineCore, 'AWS CDK construct library for Pipeline Builder: the Builder construct that assembles plugin specs into a CodePipeline stack, PluginLookup custom resource, pipeline/plugin domain types, and shared configuration.');
if (pipelineCore.jest) pipelineCore.jest.config.maxWorkers = 1;
pipelineCore.postCompileTask.exec('copyfiles -f ./pnpm-lock.yaml lib/handlers/ --verbose --error');

// -- API Server --
const apiServer = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/api-server',
  outdir: './packages/api-server',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.5.2', 'helmet@8.2.0', 'cors@2.8.6', 'compression@1.8.1',
    'jsonwebtoken@9.0.3', 'uuid@14.0.0', 'prom-client@15.1.3',
    'swagger-ui-express@5.0.1', 'ioredis@5.11.1', 'rate-limit-redis@5.0.0',
    '@opentelemetry/sdk-node@0.218.0', '@opentelemetry/exporter-trace-otlp-http@0.218.0',
    '@opentelemetry/resources@2.7.1', '@opentelemetry/auto-instrumentations-node@0.76.0',
    // Direct dep so the ESM loader hook (hook.mjs) is resolvable from the
    // otel-bootstrap preload (it patches `import`ed modules; the CJS
    // require-in-the-middle path doesn't cover ESM services).
    '@opentelemetry/instrumentation@0.218.0',
    '@opentelemetry/api@1.9.1',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/express-serve-static-core@5.1.1',
    '@types/compression@1.8.1', '@types/cors@2.8.19', '@types/jsonwebtoken@9.0.10',
    '@types/swagger-ui-express@4.1.8', '@types/node@25.9.2', `typescript@${typescriptVersion}`,
  ],
});
apiServer.eslint?.addRules({...rules, 'import/no-unresolved': 'off' });
apiServer.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(apiServer, 'Express server infrastructure for Pipeline Builder: app factory, middleware (CORS, Helmet, rate limiting, idempotency, ETag), request context, route wrappers, health-check helpers, and SSE support.');
if (apiServer.jest) apiServer.jest.config.maxWorkers = 1;

// -- AI Core --
const aiCore = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/ai-core',
  outdir: './packages/ai-core',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    'ai@6.0.198',
    '@ai-sdk/anthropic@3.0.81', '@ai-sdk/openai@3.0.68', '@ai-sdk/google@3.0.80',
    '@ai-sdk/xai@3.0.93', '@ai-sdk/amazon-bedrock@4.0.113', '@ai-sdk/openai-compatible@2.0.48',
  ],
  devDeps: ['@types/node@25.9.2', `typescript@${typescriptVersion}`],
});
aiCore.eslint?.addRules(rules);
// Published to npm: the released pipeline-manager CLI hard-depends on ai-core
// (its AI-provider registry), so it MUST ship in lockstep — otherwise consumers
// of pipeline-manager can't resolve `@pipeline-builder/ai-core@<version>`.
// Listed in LIBRARY_PROJECTS (projenrc/workflow.ts) so the release publishes it.
aiCore.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(aiCore, 'Shared AI provider registry for Pipeline Builder: lazily initialized SDK wrappers for Anthropic, OpenAI, Google, xAI, and Bedrock used by AI-assisted pipeline and plugin generation.');

// -- Pipeline Events (CodePipeline → Reporting Lambda) --
const pipelineEvents = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-events',
  outdir: './packages/pipeline-events',
  deps: [],
  devDeps: [
    '@types/node@25.9.2', '@types/aws-lambda@8.10.162',
    '@aws-sdk/client-secrets-manager@3.1064.0',
    // devDep only: the handler dynamic-imports the CodePipeline client at runtime
    // (AWS Lambda provides @aws-sdk v3); pinned to the same version as the other
    // @aws-sdk clients so it doesn't perturb the shared tree, and externalized
    // from the Lambda bundle.
    '@aws-sdk/client-codepipeline@3.1064.0',
    `typescript@${typescriptVersion}`,
  ],
});
pipelineEvents.eslint?.addRules(rules);
// Published to npm: `pipeline-manager setup-events` runs `npm install
// @pipeline-builder/pipeline-events@<version>` to fetch the Lambda handler it
// uploads (see commands/setup-events.ts), so it must be on the registry and
// version-synced. Listed in LIBRARY_PROJECTS (projenrc/workflow.ts).
pipelineEvents.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(pipelineEvents, 'AWS Lambda handler for Pipeline Builder that ingests CodePipeline state-change events from EventBridge and forwards normalized payloads to the reporting service.');

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
    `@pipeline-builder/ai-core@${pkg.aiCore}`,
    `typescript@${typescriptVersion}`, `aws-cdk-lib@${cdkVersion}`,
    '@aws-sdk/client-cloudformation@3.1064.0', '@aws-sdk/client-lambda@3.1064.0',
    '@aws-sdk/client-secrets-manager@3.1064.0', '@aws-sdk/client-sts@3.1064.0',
    'form-data@4.0.5', 'commander@15.0.0', 'figlet@1.11.0',
    'axios@1.17.0', 'progress@2.0.3', 'picocolors@1.1.1', 'yaml@2.9.0', 'ora@9.4.0',
    'zod@4.4.3',
  ],
  devDeps: ['@types/figlet@1.7.0', '@types/progress@2.0.7', 'copyfiles@2.4.1'],
});
manager.eslint?.addRules({...rules, '@typescript-eslint/no-shadow': 'off' });
manager.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
addPackageMetadata(manager, 'CLI for Pipeline Builder  self-service AWS CodePipeline platform with 125 reusable containerized plugins, per-org compliance enforcement, and per-organization (and team) isolation.');
manager.addPackageIgnore('/dist/js/');
manager.postCompileTask.exec('copyfiles -f ./cdk.json dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./config.yml dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./src/templates/*.json dist/templates/ --verbose --error');
manager.addTask('audit', { exec: 'pnpm audit --audit-level=high', description: 'Check for known vulnerabilities in dependencies' });

// =============================================================================
// Platform Service
// =============================================================================

const platform = new FunctionProject({
...baseDefaults, parent: root,
  name: 'platform',
  outdir: './platform',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    // api-server is pulled in for `currentTraceId` (read the active span's trace
    // id at audit-write time) AND for the shared `otel-bootstrap.js` preload
    // (node -r @pipeline-builder/api-server/lib/otel-bootstrap.js — see
    // Dockerfile/start). The preload's OpenTelemetry deps resolve from
    // api-server, so platform needs no direct @opentelemetry/* deps.
    `@pipeline-builder/api-server@${pkg.apiServer}`,
    // Postgres data layer (drizzle schema + connection + tenant context).
    // Pulled in for the dashboards CRUD path (Postgres-backed); platform's
    // identity/auth/observability code remains Mongo-backed.
    `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    `express@${expressVersion}`, 'express-rate-limit@8.5.2',
    'nodemailer@8.0.10', 'zod@4.4.3', '@aws-sdk/client-sesv2@3.1064.0',
    'jsonwebtoken@9.0.3', 'slugify@1.6.9', 'winston@3.19.0', 'bcryptjs@3.0.3',
    'mongoose@9.6.3', 'helmet@8.2.0', 'cors@2.8.6',
    'pg@8.21.0', 'drizzle-orm@0.45.2', 'uuid@14.0.0', 'yaml@2.9.0',
    'adm-zip@0.5.17', 'multer@2.1.1', 'prom-client@15.1.3',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/express-serve-static-core@5.1.1',
    '@types/nodemailer@8.0.0', '@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19',
    '@types/node@25.9.2', '@types/pg@8.20.0', '@types/adm-zip@0.5.8',
    '@types/multer@2.1.0', 'copyfiles@2.4.1',
    // Real-Mongo integration test (organization-id-storage.integration.test.ts).
    // The test self-skips unless RUN_MONGO_INTEGRATION=1, so the default suite
    // never spins up mongod; this dep is only exercised on the opt-in path.
    'mongodb-memory-server@11.2.0',
  ],
});
platform.postCompileTask.exec('copyfiles -f ./src/utils/email-templates/*.html lib/utils/email-templates/ --verbose --error');
platform.addScripts(dockerScripts('platform'));
platform.eslint?.addRules(rules);

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
    // Inherit the workspace-wide jestVersion pin (see top of file).
...baseDefaults.jestOptions,
    jestConfig: {
      // jsdom enables RTL's render() and visibility/event hooks used by
      // the observability dashboard render tests. Existing pure-logic
      // tests don't care about the env so the switch is safe.
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/test/**/*.test.ts', '<rootDir>/test/**/*.test.tsx'],
      // Auto-extends jest's expect() with `toBeInTheDocument`, `toHaveTextContent`,
      // etc. from @testing-library/jest-dom  so per-test imports aren't needed.
      setupFilesAfterEnv: ['<rootDir>/test/jest.setup.ts'],
    },
  },
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/api-server@${pkg.apiServer}`,
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    'next@16.2.7', 'react@19.2.7', 'react-dom@19.2.7',
    'lucide-react@1.17.0', 'tailwindcss@4.3.0', 'framer-motion@12.40.0',
    // drag-resize on the dashboard editor. Loaded only on the editor
    // page (next/dynamic) so non-editor traffic doesn't pay the ~120 KB cost.
    // `react-resizable` is a transitive dep of react-grid-layout but must be
    // declared directly so pnpm strict mode lets the editor import its CSS.
    'react-grid-layout@2.2.3', 'react-resizable@4.0.1',
  ],
  devDeps: [
    '@types/node@25.9.2', '@types/react@19.2.17', '@types/react-dom@19.2.3',
    '@tailwindcss/postcss@4.3.0', 'autoprefixer@10.5.0',
    'postcss@8.5.15', 'ts-jest@^29.4.11', `typescript@${typescriptVersion}`,
    // No @types/react-grid-layout: v2 ships its own types (Layout = readonly LayoutItem[]).
    // RTL stack for component / page render tests.
    '@testing-library/react@16.3.2',
    '@testing-library/jest-dom@6.9.1',
    '@testing-library/user-event@14.6.1',
    // Must track jestVersion's 30.4.x line: jest-runtime 30.4.x calls the jsdom
    // env's moduleMocker.clearMocksOnScope (added in jest-mock 30.4.x). An older
    // jsdom env builds its moduleMocker from an older jest-mock without it,
    // crashing every jsdom test. (jest-environment-jsdom's latest 30.4.x is
    // 30.4.1, one patch behind jest core's 30.4.2 — they release together.)
    'jest-environment-jsdom@30.4.1',
  ],
});
if (frontend.jest) {
  frontend.jest.config.transform = { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: { ignoreCodes: [151002] } }] };
  frontend.jest.config.moduleNameMapper = {
'^uuid$': '<rootDir>/../jest-uuid-stub.js',
    '^@/(.*)$': '<rootDir>/src/$1',
  };
  // Next.js's standalone build copies frontend/package.json into
  // .next/standalone/, which collides with the root in jest's haste map.
  // Ignoring `.next/` from both module and test resolution keeps the
  // haste index stable across `next build` runs.
  frontend.jest.config.modulePathIgnorePatterns = ['<rootDir>/.next/'];
  frontend.jest.config.testPathIgnorePatterns = ['/node_modules/', '<rootDir>/.next/'];
}
frontend.addScripts(dockerScripts('frontend'));
// Exclude the pack-destination from the package itself. `build » package` runs
// `pnpm pack --pack-destination dist/js`, so without this each pack re-bundles
// every prior tarball in dist/js — the frontend snowballed 360M → 1.1G → 2.1G
// until `pnpm pack` hit Node's 2 GiB readFileSync limit. (Mirrors `manager`.)
frontend.addPackageIgnore('/dist/js/');

// =============================================================================
// API Services (data-driven)
// =============================================================================

const services: Array<{ name: string; deps: string[]; devDeps?: string[] }> = [
  {
    name: 'quota',
    deps: ['cors@2.8.6', 'express-rate-limit@8.5.2', 'helmet@8.2.0', 'jsonwebtoken@9.0.3', 'mongoose@9.6.3', 'winston@3.19.0', 'zod@4.4.3'],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19'],
  },
  {
    name: 'billing',
    deps: [
      `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
      'cors@2.8.6', 'express-rate-limit@8.5.2', 'helmet@8.2.0', 'jsonwebtoken@9.0.3', 'mongoose@9.6.3', 'winston@3.19.0', 'zod@4.4.3',
      '@aws-sdk/client-marketplace-metering@3.1064.0', '@aws-sdk/client-marketplace-entitlement-service@3.1064.0',
      // stripe v22's CJS type entry (`export = StripeConstructor`) doesn't expose
      // the `Stripe.Subscription` namespace to NodeNext+CJS — but billing is ESM,
      // so it resolves stripe's ESM types and uses `Stripe.Subscription` natively.
      'stripe@22.2.0',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19'],
  },
  {
    name: 'plugin',
    deps: [
      `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
      'express-rate-limit@8.5.2', 'jsonwebtoken@9.0.3', 'helmet@8.2.0', 'cors@2.8.6',
      'pg@8.21.0', 'drizzle-orm@0.45.2', 'uuid@14.0.0', 'yaml@2.9.0',
      'adm-zip@0.5.17', 'yauzl@3.4.0', 'multer@2.1.1', `@pipeline-builder/ai-core@${pkg.aiCore}`, 'zod@4.4.3',
      'bullmq@5.78.0', 'ioredis@5.11.1',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19', '@types/pg@8.20.0', '@types/adm-zip@0.5.8', '@types/yauzl@2.10.3', '@types/multer@2.1.0'],
  },
  {
    name: 'pipeline',
    deps: [
      `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
      'express-rate-limit@8.5.2', 'jsonwebtoken@9.0.3', 'helmet@8.2.0', 'cors@2.8.6',
      'pg@8.21.0', 'drizzle-orm@0.45.2', 'uuid@14.0.0', 'yaml@2.9.0',
      `@pipeline-builder/ai-core@${pkg.aiCore}`, 'zod@4.4.3',
      '@aws-sdk/client-codepipeline@3.1064.0',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19', '@types/pg@8.20.0'],
  },
  {
    name: 'message',
    deps: [`@pipeline-builder/pipeline-data@${pkg.pipelineData}`, 'pg@8.21.0', 'drizzle-orm@0.45.2', 'uuid@14.0.0', 'ws@8.21.0', 'zod@4.4.3'],
    devDeps: ['@types/pg@8.20.0', '@types/ws@8.18.1'],
  },
  {
    name: 'reporting',
    deps: [`@pipeline-builder/pipeline-data@${pkg.pipelineData}`, 'pg@8.21.0', 'drizzle-orm@0.45.2', 'zod@4.4.3'],
    devDeps: ['@types/pg@8.20.0'],
  },
  {
    name: 'compliance',
    deps: [`@pipeline-builder/pipeline-data@${pkg.pipelineData}`, 'pg@8.21.0', 'drizzle-orm@0.45.2', 'uuid@14.0.0', 'zod@4.4.3', 'bullmq@5.78.0'],
    devDeps: ['@types/pg@8.20.0'],
  },
  {
    // Docker Registry token-auth issuer + image management API.
    // Hosts /token (per Distribution token-auth spec) and /api/images/*
    // for catalog/get/delete/tag-copy ops. Validates inbound Basic auth
    // against platform JWTs, the build service account, or platform user
    // creds; signs outgoing registry tokens with RS256.
    name: 'image-registry',
    deps: [
      'cors@2.8.6', 'express-rate-limit@8.5.2', 'helmet@8.2.0',
      'jsonwebtoken@9.0.3', 'winston@3.19.0', 'zod@4.4.3', 'axios@1.17.0',
    ],
    devDeps: ['@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19'],
  },
];

for (const svc of services) {
  const project = new FunctionProject({
...baseDefaults, parent: root,
    name: svc.name,
    deps: [...commonServiceDeps,...svc.deps],
    devDeps: [...commonServiceDevDeps,...(svc.devDeps ?? [])],
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

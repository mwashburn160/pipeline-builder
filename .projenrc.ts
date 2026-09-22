// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @stylistic/max-len */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Eslint, NodePackageManager, NpmAccess, UpdateSnapshot } from 'projen/lib/javascript';
import { TextFile } from 'projen';
import { TypeScriptProject } from 'projen/lib/typescript';
import { pnpmWorkspaceYamlOptions, setWorkspacePackages } from './projenrc/pnpm';
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
const constructsVersion = '10.8.1';
// The `constructs` range pipeline-core declares as a PEER dep. Kept equal to
// aws-cdk-lib's own `constructs` peer range so a consumer that satisfies
// aws-cdk-lib always satisfies pipeline-core too  no second copy can appear.
const constructsPeerRange = '10.5.0';
// TypeScript 7 (native Go compiler) via the dual-package pattern. `typescript@7`
// is ESM-only and its package root exports ONLY `{ version, versionMajorMinor }`
// (lib/version.cjs) — the classic JS compiler API is gone, replaced by the
// separate `./unstable/{sync,async,ast}` surface. Every tool here that drives the
// compiler programmatically needs the classic API: ts-jest's ConfigSet
// (peer `typescript: ">=4.3 <7"`), `@typescript-eslint/parser` (peer
// `typescript: ">=4.8.4 <6.1.0"`), and this very file (`ts.isInterfaceDeclaration`
// & co. in the barrel drift-check below). So `typescript` is aliased to Microsoft's
// own compat package `@typescript/typescript6` (main: lib/typescript.js — the
// classic API) and the real TS7 compiler is installed alongside as
// `@typescript/native` (see the shared devDeps), which is what `tsc` runs.
// This is not a stopgap for a lagging tool: it is how TS 7 is consumed until the
// ecosystem moves to the `unstable` API.
const typescriptVersion = 'npm:@typescript/typescript6@^6.0.2';
const tsNativeDep = '@typescript/native@npm:typescript@^7.0.2';
const cdkVersion = '2.270.0';
const expressVersion = '5.2.1';

// jest version, applied to every project. There is no `@types/jest` ceiling to
// work around here: every package is ESM and imports its test globals from
// `@jest/globals`, which is self-typed, so nothing depends on `@types/jest` and
// projen never has to pin it. See `configureEsmJest` in projenrc/shared-config.ts.
const jestVersion = '30.5.2';

// @types/node for EVERY project — ONE constant, tracking the runtime's major
// (minNodeVersion 24.14.0 below; the images run node 24). It used to be pinned
// separately at 26.x in nine places, so the type-checker accepted Node 26 APIs
// that crash on the Node 24 the services actually run on.
const typesNode = '@types/node@^24';

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
  projenVersion: '0.103.26',
  minNodeVersion: '24.14.0',
  minMajorVersion: 4,
  packageManager: NodePackageManager.PNPM,
  // projen emits pnpm-workspace.yaml itself; our workspace settings (package
  // paths + the pnpm install policy) go through it. See projenrc/pnpm.ts.
  pnpmOptions: { workspaceYamlOptions: pnpmWorkspaceYamlOptions },
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
    '@swc-node/core@1.15.0',
    '@swc-node/register@1.12.1',
    `constructs@${constructsVersion}`,
    'npm-check-updates@23.1.0',
  ],
});
root.addScripts({ 'npm-check': 'npx npm-check-updates' });

// Keep the `packageManager` field and `devEngines.packageManager` in lockstep on
// the pinned workspace pnpm version. projen defaults `packageManager` to its
// bundled pnpm (10.x) and emits a `>=10` devEngines range, so the two "differ"
// and pnpm warns + ignores `packageManager`. Pin both to `pnpmVersion`.
root.package.addField('packageManager', `pnpm@${pnpmVersion}`);
root.package.addField('devEngines', { packageManager: { name: 'pnpm', version: pnpmVersion, onFail: 'ignore' } });

// The workspace root (`root@0.0.0`) is a container, never an npm package. Mark it
// private so `pnpm publish` (which falls back to the CWD package when no --filter
// matches) can never try to publish it — the E403 the release workflow hit.
root.package.addField('private', true);

// All internal packages publish to npmjs.org under @pipeline-builder scope
root.npmrc.addConfig('@pipeline-builder:registry', 'https://registry.npmjs.org/');

// Run pnpm workspace recursive operations (install, build, test) one at a
// time. Higher concurrency overlaps docker buildx, registry pushes, and
// per-tier buildkitd warmup in ways that race on shared resources (the same
// Redis DB, the local docker daemon, the same per-org KMS keys); serializing
// trades wall-clock for reliability.
root.npmrc.addConfig('workspace-concurrency', '1');
// NOTE: pnpm's `verifyDepsBeforeRun` is disabled in pnpm-workspace.yaml
// (projenrc/pnpm.ts) — `.npmrc` is not consulted for it.

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
  //
  // `UpdateSnapshot.NEVER`: `test` runs `jest --ci` — a snapshot that no longer
  // matches FAILS instead of being silently rewritten (projen's default passes
  // `--updateSnapshot`, which made every snapshot assertion in CI a no-op).
  // Refresh snapshots deliberately with the generated `test:update` task.
  jestOptions: { jestVersion, updateSnapshot: UpdateSnapshot.NEVER },
};

/** esbuild command that bundles a Lambda entry into one self-contained ESM file
 *  (the Lambda Node runtime provides `@aws-sdk/*`). */
const LAMBDA_BUNDLE = (entry: string, outfile: string): string =>
  `esbuild ${entry} --bundle --platform=node --format=esm --target=node24 --external:@aws-sdk/* --log-level=warning --outfile=${outfile}`;

const pkgDefaults = {
...baseDefaults,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
};

/**
 * Selectors for a hand-written object-literal module factory:
 * `jest.unstable_mockModule('<pkg>', () => ({ … }))` and the block form
 * `() => { …; return { … }; }`. `unstable_mockModule` replaces the WHOLE
 * namespace, so any export the literal forgot linked as `undefined` (or failed
 * outright with "does not provide an export named X") the moment production code
 * reached for it — the api-core, api-server, pipeline-data and pipeline-core
 * literals all broke the build this way. `specifierMatch` is an esquery
 * attribute test on the specifier (`='drizzle-orm'` or a `=/regex/`).
 *
 * Deliberately narrow: only the LITERAL factory is matched, so
 * `() => drizzleMock({ … })`, `() => apiCoreMock({ … })` and
 * `() => stubModule('@pipeline-builder/x', { … })` (and any other
 * factory-call form) pass.
 */
const inlineModuleMockSelectors = (specifierMatch: string) => {
  const call = `CallExpression[callee.property.name='unstable_mockModule'][arguments.0.value${specifierMatch}]`;
  return [
    `${call} > ArrowFunctionExpression[body.type='ObjectExpression']`,
    `${call} > ArrowFunctionExpression > BlockStatement > ReturnStatement[argument.type='ObjectExpression']`,
  ];
};

/** The restricted-syntax entries banning an inline literal mock of the matched specifier(s). */
const noInlineModuleMock = (specifierMatch: string, what: string, useInstead: string) =>
  inlineModuleMockSelectors(specifierMatch).map((selector) => ({
    selector,
    message: `Don't hand-roll the ${what} module mock: it replaces the whole namespace, so any export it omits links as undefined and breaks the moment production code reaches for it. ${useInstead} (see docs/testing.md).`,
  }));

/**
 * BANNED: inline literal mocks of `drizzle-orm` and of EVERY
 * `@pipeline-builder/*` module. api-core has its per-project `apiCoreMock`
 * (the real module spread, plus defaults); every other workspace package —
 * including the framework/DB boundaries (api-server, pipeline-data) a unit test
 * legitimately replaces wholesale — goes through `stubModule(specifier, { … })`,
 * which returns EVERY export in the package's build-time manifest
 * (lib/testing/exports.json) as a loud stub unless overridden. That keeps the
 * wholesale replacement those suites need without dragging in the real
 * Express/Postgres wiring, and without the literal's drift. (`\x2f` is `/`:
 * esquery's regex literal cannot contain a bare slash.)
 */
const restrictedModuleMocks = [
  ...noInlineModuleMock("='drizzle-orm'", "'drizzle-orm'", "Use drizzleMock({ … }) from '@pipeline-builder/api-core/testing'"),
  ...noInlineModuleMock("='@pipeline-builder/api-core'", "'@pipeline-builder/api-core'", "Use your project's apiCoreMock({ … }) from test/helpers/mock-api-core.ts"),
  ...noInlineModuleMock(
    '=/^@pipeline-builder\\x2f(?!api-core$)/',
    "'@pipeline-builder/*'",
    "Use stubModule('<specifier>', { … }) from '@pipeline-builder/api-core/testing' — it stubs every export in the package's lib/testing/exports.json",
  ),
];

/**
 * api-core's test helpers are their own package entry,
 * `@pipeline-builder/api-core/testing`. The built files still sit under
 * `lib/testing/` (the `./lib/*` export stays open for deep imports of internals),
 * so ban reaching them that way — one import path, not two.
 */
const restrictedImports = {
  patterns: [{
    group: ['@pipeline-builder/api-core/lib/testing', '@pipeline-builder/api-core/lib/testing/*'],
    message: "Import test helpers from '@pipeline-builder/api-core/testing' (its own package entry), not the built lib/testing path.",
  }],
};

const rules: Record<string, unknown> = {
  '@stylistic/max-len': 'off',
  'import/no-extraneous-dependencies': 'off',
  '@typescript-eslint/member-ordering': 'off',
  'no-restricted-syntax': ['error', ...restrictedModuleMocks],
  'no-restricted-imports': ['error', restrictedImports],
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

/**
 * Projects shipped as Docker images / published to npm. Filled as the projects
 * are defined (dockerScripts / publishToNpm) and handed to the release workflow
 * and deploy/shared/services.txt, so neither keeps its own hand-written list.
 */
const imageProjects: string[] = [];
const libraryProjects: string[] = [];

/** Publish a library to npm (public, in lockstep with the release). */
function publishToNpm(project: TypeScriptProject): void {
  project.package.addField('publishConfig', { access: 'public', registry: 'https://registry.npmjs.org/' });
  libraryProjects.push(project.package.packageName.replace(/^@pipeline-builder\//, ''));
}

function dockerScripts(name: string) {
  imageProjects.push(name);
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
    // GUARD: `pnpm deploy` under the wrong pnpm major silently symlinks the
    // @pipeline-builder/* workspace deps to the SOURCE checkout instead of
    // materializing real copies in the bundle. Those absolute symlinks dangle
    // inside the container → every service CrashLoops with
    // `ERR_MODULE_NOT_FOUND: Cannot find package '@pipeline-builder/api-server'`.
    // (pnpm 11 broke this; the pin is 10.33.0.) Assert the active pnpm matches
    // this package's `packageManager` pin before staging so a mismatched host
    // fails loudly here instead of shipping a broken image. Reads the local
    // package.json (docker:build runs from the service dir).
    'PB_EXPECTED_PNPM=$(jq -r .packageManager package.json | sed "s/^pnpm@//")',
    'PB_ACTUAL_PNPM=$(pnpm --version)',
    '[ "$PB_EXPECTED_PNPM" = "$PB_ACTUAL_PNPM" ] || { echo "ERROR: pnpm $PB_ACTUAL_PNPM is active but package.json pins pnpm@$PB_EXPECTED_PNPM. Run: corepack prepare pnpm@$PB_EXPECTED_PNPM --activate" >&2; exit 1; }',
    `pnpm nx run-many -t build --projects=${name} --with-deps`,
    'rm -rf .docker-build',
    `pnpm deploy --filter ${name} --prod --legacy .docker-build`,
    // VALIDATE: every @pipeline-builder/* dep in the staged bundle must be a
    // REAL materialized package, not a dangling workspace symlink. `-e .../package.json`
    // follows the symlink, so an escaped/dangling link fails the build here
    // rather than at container startup. Belt-and-suspenders behind the guard.
    'for d in .docker-build/node_modules/@pipeline-builder/*; do test -e "$d/package.json" || { echo "ERROR: staged bundle dep $d is a dangling workspace symlink (wrong pnpm version staged the bundle). See the docker:build pnpm guard." >&2; exit 1; }; done',
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
  typesNode,
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
    'jsonwebtoken@9.0.3', 'winston@3.19.0', 'zod@4.6.5',
    '@asteasolutions/zod-to-openapi@9.1.0',
    // AWS-KMS KeyProvider  bundled as a regular dep so the
    // KmsKeyProvider class can be imported without operator-side install
    // steps. Lazy-loaded at first use; envs that stick with the
    // EnvKeyProvider don't construct a KMS client.
    '@aws-sdk/client-kms@3.1136.0',
    // STS + credential-providers for the per-org IAM role assumption
    // helper. Same posture as the KMS client: lazy-imported, only loads
    // when an operator configures a per-org assumeRoleArn.
    '@aws-sdk/client-sts@3.1136.0',
    '@aws-sdk/credential-providers@3.1136.0',
    // Redis client for the env-based token-revocation READER
    // (createEnvRedisTokenRevocationStore). Loaded via a guarded dynamic require
    // only when a service configures REDIS_URL/REDIS_SENTINELS, so it stays optional
    // at runtime; declared here so the require resolves in every consumer.
    'ioredis@6.0.0',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/jsonwebtoken@9.0.10',
    typesNode, `typescript@${typescriptVersion}`,
  ],
});
apiCore.eslint?.addRules({...rules, '@typescript-eslint/no-shadow': 'off' });
publishToNpm(apiCore);
// Entry points. The root pulls in the server graph (express, jwt, ioredis);
// `./permissions` (permission catalog + labels + picker grouping),
// `./metadata-keys` (the pipeline metadata-key catalog that also backs
// pipeline-core's `MetadataKeys`), `./feature-flags` (feature-flag catalog +
// display metadata) and `./plugin-catalog` (plugin category / catalog-field
// vocabulary) are dependency-free and imported by the BROWSER — the frontend
// consumes them directly instead of keeping hand-maintained mirrors. `./testing` is the test-helper entry (src/testing):
// never part of the root barrel, and dropped from the packed package below so
// no service image ships it. `./lib/*` stays open because tests deep-import
// internals the root barrel narrows away (e.g. `lib/services/service-keys.js`).
apiCore.package.addField('exports', {
  '.': { types: './lib/index.d.ts', default: './lib/index.js' },
  './permissions': { types: './lib/types/permissions.d.ts', default: './lib/types/permissions.js' },
  './metadata-keys': { types: './lib/types/metadata-keys.d.ts', default: './lib/types/metadata-keys.js' },
  './feature-flags': { types: './lib/types/feature-flags.d.ts', default: './lib/types/feature-flags.js' },
  './plugin-catalog': { types: './lib/types/plugin-catalog.d.ts', default: './lib/types/plugin-catalog.js' },
  './testing': { types: './lib/testing/index.d.ts', default: './lib/testing/index.js' },
  './lib/*': './lib/*',
  './package.json': './package.json',
});
// The frontend's jest tsconfig resolves modules with node10, which ignores
// `exports` — typesVersions is what points it at the subpath's declarations.
apiCore.package.addField('typesVersions', {
  '*': {
    permissions: ['lib/types/permissions.d.ts'],
    'metadata-keys': ['lib/types/metadata-keys.d.ts'],
    'feature-flags': ['lib/types/feature-flags.d.ts'],
    'plugin-catalog': ['lib/types/plugin-catalog.d.ts'],
  },
});
// Test helpers are workspace-only: `pnpm deploy --prod` (every service image)
// packs by the npmignore, so this keeps lib/testing out of production.
apiCore.addPackageIgnore('/lib/testing/');
addPackageMetadata(apiCore, 'Core server-side utilities (auth middleware, response helpers, error codes, quota service, HTTP client, logging, AI provider catalog) shared by every Pipeline Builder backend service.');

// -- Pipeline Data --
const pipelineData = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-data',
  outdir: './packages/pipeline-data',
  deps: [`@pipeline-builder/api-core@${pkg.apiCore}`, 'pg@8.23.0', 'drizzle-orm@0.45.3'],
  // PGlite: in-process Postgres (WASM) for the RLS integration suite, which
  // applies the real postgres-init.sql — no Docker needed in CI.
  devDeps: [typesNode, '@types/pg@8.23.1', 'drizzle-kit@0.31.11', `typescript@${typescriptVersion}`, '@electric-sql/pglite@0.5.8'],
});
pipelineData.eslint?.addRules(rules);
publishToNpm(pipelineData);
addPackageMetadata(pipelineData, 'Database layer for Pipeline Builder: Drizzle ORM schemas, connection management, query builders, and the generic CrudService base class with per-organization (and team) access control.');

// -- Pipeline Core --
const pipelineCore = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-core',
  outdir: './packages/pipeline-core',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
    'jsonwebtoken@9.0.3', 'axios@1.20.0',
  ],
  // `aws-cdk-lib` / `constructs` are PEER deps, not regular deps  the standard
  // shape for a published CDK construct library. As regular deps they were a
  // correctness bug: pipeline-core pinned `constructs` exactly, so any consumer
  // resolving a different 10.x (npm satisfies aws-cdk-lib's own `constructs:
  // ^10.5.0` peer by hoisting the latest) got a SECOND nested copy. A construct
  // built by core's copy then blew up when passed as scope to a construct built
  // by aws-cdk-lib's copy (`scope.node._scopes is not iterable`). As peers, core
  // never brings its own copy  it always uses the consumer's, so duplication is
  // structurally impossible rather than a matter of keeping pins in lockstep.
  // The `constructs` range deliberately MIRRORS aws-cdk-lib's own peer range, so
  // anything satisfying aws-cdk-lib necessarily satisfies core.
  peerDeps: [`constructs@^${constructsPeerRange}`, `aws-cdk-lib@^${cdkVersion}`],
  // Don't let projen auto-pin the peers as devDeps at the range minimum  we
  // build and test against the exact versions the apps ship.
  peerDependencyOptions: { pinnedDevDependency: false },
  devDeps: [
    `constructs@${constructsVersion}`, `aws-cdk-lib@${cdkVersion}`,
    typesNode, '@types/aws-lambda@8.10.163', '@types/jsonwebtoken@9.0.10',
    '@aws-sdk/client-secrets-manager@3.1136.0', 'copyfiles@2.4.1',
  ],
});
pipelineCore.eslint?.addRules(rules);
publishToNpm(pipelineCore);
// Entry points. The root is free of `aws-cdk-lib` (config, domain types, template
// engine) so the API services that import it never load the CDK; `/cdk` carries the
// constructs and the synth-time authoring types; `/template` is the dependency-free
// template tokenizer the BROWSER shares for inline `{{ … }}` validation. `./lib/*`
// stays open because tests deep-import concrete modules (e.g. billing mocks
// `lib/config/entitlements.js`).
pipelineCore.package.addField('exports', {
  '.': { types: './lib/index.d.ts', default: './lib/index.js' },
  './cdk': { types: './lib/cdk.d.ts', default: './lib/cdk.js' },
  './template': { types: './lib/template/tokenizer.d.ts', default: './lib/template/tokenizer.js' },
  './lib/*': './lib/*',
  './package.json': './package.json',
});
// Same node10 caveat as api-core: typesVersions points the frontend's jest
// tsconfig at the browser subpath's declarations.
pipelineCore.package.addField('typesVersions', {
  '*': {
    template: ['lib/template/tokenizer.d.ts'],
  },
});
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
    'express-rate-limit@8.7.0', 'helmet@8.3.0', 'cors@2.8.6', 'compression@1.8.2',
    'uuid@14.0.2', 'prom-client@15.1.3',
    'swagger-ui-express@5.0.1', 'rate-limit-redis@6.0.1',
    '@opentelemetry/sdk-node@0.222.0', '@opentelemetry/exporter-trace-otlp-http@0.222.0',
    '@opentelemetry/resources@2.11.0', '@opentelemetry/auto-instrumentations-node@0.80.0',
    // Direct dep so the ESM loader hook (hook.mjs) is resolvable from the
    // otel-bootstrap preload (it patches `import`ed modules; the CJS
    // require-in-the-middle path doesn't cover ESM services).
    '@opentelemetry/instrumentation@0.222.0',
    '@opentelemetry/api@1.9.1',
    // Server-side untrusted-markdown renderer (`lib/markdown.js`, plugin
    // READMEs / advisories / reviews).
    // ESM-only; reached through the subpath, never the package root.
    'unified@11.0.5', 'remark-parse@11.0.0', 'remark-gfm@4.0.1', 'remark-rehype@11.1.2',
    'rehype-sanitize@6.0.0', 'rehype-stringify@10.0.1',
  ],
  devDeps: [
    '@types/hast@3.0.5',
    '@types/express@5.0.6', '@types/express-serve-static-core@5.1.3',
    '@types/compression@1.8.1', '@types/cors@2.8.19', 'jsonwebtoken@9.0.3', '@types/jsonwebtoken@9.0.10',
    '@types/swagger-ui-express@4.1.8', typesNode, `typescript@${typescriptVersion}`,
  ],
});
apiServer.eslint?.addRules({...rules, 'import/no-unresolved': 'off' });
publishToNpm(apiServer);
addPackageMetadata(apiServer, 'Express server infrastructure for Pipeline Builder: app factory, middleware (CORS, Helmet, rate limiting, idempotency, ETag), request context, route wrappers, health-check helpers, and SSE support.');
if (apiServer.jest) apiServer.jest.config.maxWorkers = 1;

// -- AI Core --
const aiCore = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/ai-core',
  outdir: './packages/ai-core',
  deps: [
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    'ai@7.0.107',
    '@ai-sdk/anthropic@4.0.58', '@ai-sdk/openai@4.0.71', '@ai-sdk/google@4.0.76',
    '@ai-sdk/xai@5.0.4', '@ai-sdk/amazon-bedrock@5.0.88', '@ai-sdk/openai-compatible@3.0.53',
    // Bedrock is the one KEYLESS provider: it authenticates with the runtime's
    // IAM role (EKS Pod Identity / IRSA / EC2 instance profile). The ai-sdk
    // provider only reads static keys unless it is handed a credential provider,
    // so the AWS default chain has to be passed in explicitly.
    '@aws-sdk/credential-providers@3.1136.0',
  ],
  devDeps: [typesNode, `typescript@${typescriptVersion}`],
});
aiCore.eslint?.addRules(rules);
// Published to npm: the released pipeline-manager CLI hard-depends on ai-core
// (its AI-provider registry), so it MUST ship in lockstep — otherwise consumers
// of pipeline-manager can't resolve `@pipeline-builder/ai-core@<version>`.
// publishToNpm registers it with the release workflow.
publishToNpm(aiCore);
addPackageMetadata(aiCore, 'Shared AI provider registry for Pipeline Builder: lazily initialized SDK wrappers for Anthropic, OpenAI, Google, xAI, and Bedrock used by AI-assisted pipeline and plugin generation.');

// -- Pipeline Events (CodePipeline → Reporting Lambda) --
const pipelineEvents = new PackageProject({
...pkgDefaults, parent: root,
  name: '@pipeline-builder/pipeline-events',
  outdir: './packages/pipeline-events',
  deps: [],
  devDeps: [
    typesNode, '@types/aws-lambda@8.10.163',
    '@aws-sdk/client-secrets-manager@3.1136.0',
    // devDep only: the handler dynamic-imports the CodePipeline client at runtime
    // (AWS Lambda provides @aws-sdk v3); pinned to the same version as the other
    // @aws-sdk clients so it doesn't perturb the shared tree, and externalized
    // from the Lambda bundle.
    '@aws-sdk/client-codepipeline@3.1136.0',
    `typescript@${typescriptVersion}`,
    // Bundled into lib/index.js (never a runtime dependency): the shared
    // platform-credential handling.
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    'esbuild@0.28.2',
  ],
});
pipelineEvents.eslint?.addRules(rules);
// `infra setup-events` ships lib/index.js as the ONE file in the Lambda zip, so
// the build bundles the handler into it (the Lambda runtime provides @aws-sdk).
pipelineEvents.postCompileTask.exec(LAMBDA_BUNDLE('src/index.ts', 'lib/index.js'));
// The handler imports @aws-sdk/client-sqs (DLQ self-healing redrive) and
// @aws-sdk/client-codecommit (commit-timestamp resolution); the tests stub both
// so no real AWS call is made. These map entries MUST live here (not just in the
// generated package.json) or projen synth drops them — which breaks the handler
// suite: CodeCommit GetCommit resolves `undefined` and the SQS/DLQ paths hang to
// the 5s jest timeout. Merge onto the shared uuid + JS-ext mappers, don't replace.
if (pipelineEvents.jest) {
  pipelineEvents.jest.config.moduleNameMapper = {
    ...pipelineEvents.jest.config.moduleNameMapper,
    '^@aws-sdk/client-sqs$': '<rootDir>/test/aws-sdk-stub.js',
    '^@aws-sdk/client-codecommit$': '<rootDir>/test/aws-sdk-stub.js',
  };
}
// Published to npm: `pipeline-manager infra setup-events` runs `npm install
// @pipeline-builder/pipeline-events@<version>` to fetch the Lambda handler it
// uploads (see commands/setup-events.ts), so it must be on the registry and
// version-synced; publishToNpm registers it with the release workflow.
publishToNpm(pipelineEvents);
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
    `@pipeline-builder/api-core@${pkg.apiCore}`,
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    `@pipeline-builder/ai-core@${pkg.aiCore}`,
    // The manager is the only package that imports `@pipeline-builder/pipeline-core/cdk`,
    // so it alone carries the cdk pins and is what satisfies pipeline-core's peer ranges.
    // `constructs` is pinned explicitly even though nothing here imports it directly:
    // left implicit, npm resolves aws-cdk-lib's `constructs: ^10.5.0` peer to the latest
    // 10.x, which is what produced the `scope.node._scopes is not iterable` crash.
    `typescript@${typescriptVersion}`, `aws-cdk-lib@${cdkVersion}`, `constructs@${constructsVersion}`,
    '@aws-sdk/client-cloudformation@3.1136.0', '@aws-sdk/client-lambda@3.1136.0',
    '@aws-sdk/client-secrets-manager@3.1136.0', '@aws-sdk/client-sts@3.1136.0',
    // `infra redrive-events` calls SQS StartMessageMoveTask (DLQ → main queue) —
    // the manual fallback for the events Lambda's self-healing redrive.
    '@aws-sdk/client-sqs@3.1136.0',
    'form-data@4.0.6', 'commander@15.0.0', 'figlet@1.11.4',
    'axios@1.20.0', 'progress@2.0.3', 'picocolors@1.1.1', 'yaml@2.9.1', 'ora@9.4.1',
    'zod@4.6.5',
  ],
  devDeps: ['@types/figlet@1.7.0', '@types/progress@2.0.7', 'copyfiles@2.4.1', 'esbuild@0.28.2'],
});
manager.eslint?.addRules({...rules, '@typescript-eslint/no-shadow': 'off' });
publishToNpm(manager);
addPackageMetadata(manager, 'CLI for Pipeline Builder  self-service AWS CodePipeline platform with 125 reusable containerized plugins, per-org compliance enforcement, and per-organization (and team) isolation.');
manager.addPackageIgnore('/dist/js/');
// `infra store-token --schedule` uploads the token-renew handler as the ONE file
// in its Lambda zip, so the build bundles it (shared platform-credential code).
manager.postCompileTask.exec(LAMBDA_BUNDLE('src/lambda/token-renew-handler.ts', 'dist/lambda/token-renew-handler.js'));
manager.postCompileTask.exec('copyfiles -f ./cdk.json dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./config.yml dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./src/templates/*.json dist/templates/ --verbose --error');
// The local equivalent of the scheduled `security-audit` workflow. Flags are kept
// IDENTICAL to `.github/workflows/security-audit.yml` so a clean local run means a
// clean CI run: `--prod` scopes to runtime dependencies (dev-only Low/Moderate noise
// is tolerated) and `--audit-level high` is what fails. pnpm audits the whole
// workspace lockfile regardless of which package the task is invoked from.
manager.addTask('audit', { exec: 'pnpm audit --prod --audit-level high', description: 'Check runtime dependencies for known High/Critical vulnerabilities (same command as the security-audit workflow)' });

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
    `express@${expressVersion}`, 'express-rate-limit@8.7.0',
    'nodemailer@10.0.10', 'zod@4.6.5', '@aws-sdk/client-sesv2@3.1136.0',
    // ES256 user-token signing with the private key held in KMS
    // (asymmetric ECC_NIST_P256, sign-only) on the AWS targets. Lazily
    // imported — a local-file-signer install never constructs a KMS client.
    '@aws-sdk/client-kms@3.1136.0',
    'jsonwebtoken@9.0.3', 'slugify@1.6.9', 'winston@3.19.0', 'bcryptjs@3.0.3',
    // WebAuthn/passkey ceremonies (registration, assertion, step-up). Dual
    // CJS/ESM, Node >= 20; the browser half is `@simplewebauthn/browser` in the
    // frontend and the two MUST stay on the same major (v14 response shapes).
    '@simplewebauthn/server@14.0.2',
    // SAML 2.0 sign-in (#4): XML-signature verification of IdP assertions.
    // Node's `crypto` cannot do this — XML-DSig needs canonicalization and
    // reference resolution — so a maintained library is the right call here.
    // CJS, but its named exports resolve cleanly from platform's ESM.
    '@node-saml/node-saml@5.1.0',
    'mongoose@9.10.1', 'helmet@8.3.0', 'cors@2.8.6',
    'pg@8.23.0', 'drizzle-orm@0.45.3', 'uuid@14.0.2', 'yaml@2.9.1',
    'adm-zip@0.6.1', 'multer@2.4.0', 'prom-client@15.1.3',
    // Redis client — used ONLY to publish session-revocation entries the
    // stateless services read (helpers/session-revocation.ts). Loaded via a
    // guarded dynamic require (utils/redis-client.ts); optional at runtime.
    'ioredis@6.0.0',
  ],
  devDeps: [
    '@types/express@5.0.6', '@types/express-serve-static-core@5.1.3',
    '@types/nodemailer@8.0.2', '@types/jsonwebtoken@9.0.10', '@types/cors@2.8.19',
    typesNode, '@types/pg@8.23.1', '@types/adm-zip@0.5.8',
    '@types/multer@2.2.0', 'copyfiles@2.4.1',
    // Real-Mongo integration test (organization-id-storage.integration.test.ts).
    // The test self-skips unless RUN_MONGO_INTEGRATION=1, so the default suite
    // never spins up mongod; this dep is only exercised on the opt-in path.
    'mongodb-memory-server@11.3.0',
    // SAML test fixtures (#4): the suite SIGNS assertions with a throwaway key
    // generated per run, so the signature/audience/expiry/rotation cases are
    // real XML-DSig verifications rather than mocks — and no test key is checked
    // into the repo. Same version node-saml itself resolves, so the two agree on
    // canonicalization. Test-only; never imported by src/.
    'xml-crypto@6.3.1',
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
    // No `api-server` here either. Nothing under frontend/ imports it: the only
    // reference was the vestigial `start` script's otel-bootstrap preload (the
    // image runs Next's standalone `server.js`, not `lib/index.js`), and that
    // script is replaced below. Carrying it made every `pnpm deploy` stage the
    // whole server package — and its transitive tree — into a bundle the
    // Dockerfile never copies.
    // pipeline-core only for its dependency-free `./template` subpath (the
    // `{{ … }}` tokenizer, so inline validation matches synth exactly); nothing
    // imports its root, which carries server/CDK-side code.
    `@pipeline-builder/pipeline-core@${pkg.pipelineCore}`,
    'next@16.3.5', 'react@19.3.0', 'react-dom@19.3.0',
    'lucide-react@1.47.0', 'tailwindcss@4.3.3', 'framer-motion@13.4.0',
    // Browser half of the WebAuthn/passkey ceremonies (registration, assertion,
    // conditional-UI autofill). Must stay on the same major as platform's
    // `@simplewebauthn/server` — v14 changed the JSON response shapes.
    '@simplewebauthn/browser@14.0.0',
    // QR encoding for the TOTP enrolment code (Reed-Solomon + masking is the one
    // part of that screen nobody should hand-roll). Chosen for having NO
    // transitive dependencies and shipping both CJS and ESM builds — `qrcode`,
    // the obvious alternative, drags yargs/pngjs/dijkstrajs into the browser
    // bundle for a CLI nobody here runs. Used through `encode()`, which returns
    // the raw module matrix so `TotpSection` renders real SVG elements instead
    // of injecting markup. Loaded only on the security tab (next/dynamic).
    'uqr@0.1.3',
    // drag-resize on the dashboard editor. Loaded only on the editor
    // page (next/dynamic) so non-editor traffic doesn't pay the ~120 KB cost.
    // `react-resizable` is a transitive dep of react-grid-layout but must be
    // declared directly so pnpm strict mode lets the editor import its CSS.
    'react-grid-layout@2.2.4', 'react-resizable@4.0.2',
  ],
  devDeps: [
    typesNode, '@types/react@19.3.0', '@types/react-dom@19.3.0',
    '@tailwindcss/postcss@4.3.3', 'autoprefixer@10.6.1',
    'postcss@8.5.28', 'ts-jest@^29.4.12', `typescript@${typescriptVersion}`, tsNativeDep,
    // No @types/react-grid-layout: v2 ships its own types (Layout = readonly LayoutItem[]).
    // RTL stack for component / page render tests.
    '@testing-library/react@16.3.3',
    '@testing-library/jest-dom@7.0.1',
    '@testing-library/user-event@14.6.7',
    // Test globals are imported from `@jest/globals` (self-typed), like every
    // other package — there is no `@types/jest`. Same pin as configureEsmJest.
    '@jest/globals@30.5.2',
    // Must track jestVersion EXACTLY: jest-runtime calls the jsdom env's
    // moduleMocker.clearMocksOnScope (added in jest-mock 30.4.x). An older jsdom
    // env builds its moduleMocker from an older jest-mock without it, crashing
    // every jsdom test. jest core and jest-environment-jsdom release together,
    // so keep this equal to jestVersion.
    'jest-environment-jsdom@30.5.2',
  ],
});
// Regenerate the in-app help topics from docs/*.md (single source of truth).
frontend.addScripts({ 'generate:help': 'node scripts/generate-help.mjs' });
// Curated plugin icons: deploy/plugins/_icons/*.svg are
// linted and copied into public/plugin-icons/ under content-hashed names, and the
// manifest src/generated/plugin-icons.ts is rewritten. Runs BEFORE `next build`
// on the host — the frontend image only copies public/, and deploy/plugins/ is
// outside its Docker context. The hashed copies are build output (gitignored);
// the manifest is committed and drift-tested.
frontend.addScripts({ 'generate:plugin-icons': 'node scripts/generate-plugin-icons.mjs' });
frontend.preCompileTask.exec('node scripts/generate-plugin-icons.mjs');
frontend.gitignore.exclude('/public/plugin-icons/');
// Type-check the test suites before running them. ts-jest only TRANSPILES, so
// nothing else ever checked them: tsconfig.test.json sat on the removed
// `moduleResolution: node10` (a fatal config error, so `tsc` never got as far as
// the code), and underneath it ~8.5k errors had accumulated unseen — tests still
// passing arguments helpers no longer take, fixtures missing fields their types
// had gained. Running it first keeps that from happening again.
const typecheckTests = frontend.addTask('typecheck:tests', {
  description: 'Type-check the frontend test suites (ts-jest only transpiles)',
  exec: 'tsc -p tsconfig.test.json --noEmit',
});
frontend.testTask.prependSpawn(typecheckTests);

// ESLint for the frontend — it had none at all (NextJsProject brings no linter),
// so nothing enforced hooks rules or accessibility. Same projen Eslint component
// and shared `rules` as every other package, plus the React layer:
//   - react (recommended + the new JSX runtime),
//   - react-hooks: the two classic rules only (v7's `recommended` also turns on
//     the React-Compiler rule family, which is a separate migration),
//   - jsx-a11y (recommended), with `label-has-associated-control` as an ERROR:
//     an unassociated <label> is invisible to screen readers and breaks
//     click-to-focus (static twin: test/label-association.test.ts).
// Spawned by `test` (and so `build`), without --fix like everywhere else.
const frontendEslint = new Eslint(frontend, {
  dirs: ['src', 'pages'],
  devdirs: ['test'],
  fileExtensions: ['.ts', '.tsx'],
  // tsconfig.json covers src/, pages/ AND test/ (tsconfig.test.json omits pages/).
  tsconfigPath: './tsconfig.json',
  commandOptions: { fix: false },
});
frontend.addDevDeps('eslint-plugin-react@7.37.5', 'eslint-plugin-react-hooks@7.1.1', 'eslint-plugin-jsx-a11y@6.10.2');
frontendEslint.addPlugins('react', 'react-hooks', 'jsx-a11y');
frontendEslint.addExtends('plugin:react/recommended', 'plugin:react/jsx-runtime', 'plugin:jsx-a11y/recommended');
frontendEslint.config.settings = { ...(frontendEslint.config.settings ?? {}), react: { version: 'detect' } };
frontendEslint.addRules({
  ...rules,
  // The frontend was never under the shared FORMATTING rules and follows its own
  // (Next/React) layout; enforcing them here would rewrite ~680 files for no
  // behavioural gain. This lint is for correctness: hooks, a11y, TS hazards.
  ...Object.fromEntries([
    'array-bracket-newline', 'array-bracket-spacing', 'brace-style', 'comma-dangle', 'comma-spacing',
    'indent', 'key-spacing', 'keyword-spacing', 'max-len', 'member-delimiter-style', 'no-multi-spaces',
    'no-multiple-empty-lines', 'no-trailing-spaces', 'object-curly-newline', 'object-curly-spacing',
    'object-property-newline', 'quote-props', 'quotes', 'semi', 'space-before-blocks',
  ].map((r) => [`@stylistic/${r}`, 'off'])),
  'import/order': 'off',
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn',
  // Props are typed by TypeScript, not PropTypes.
  'react/prop-types': 'off',
  // Focusing the first field of a just-opened dialog/step IS the accessible
  // behaviour (WAI-ARIA dialog pattern); the rule cannot tell that from a page
  // that steals focus on load.
  'jsx-a11y/no-autofocus': 'off',
  // `controlComponents`: our UI-kit wrappers that render a native <input>
  // (src/components/ui/Checkbox.tsx, FilterInput.tsx) — a <label> wrapping one
  // IS associated, the rule just cannot see through the component.
  'jsx-a11y/label-has-associated-control': ['error', { assert: 'either', depth: 3, controlComponents: ['Checkbox', 'FilterInput'] }],
  // `role` is also an ordinary PROP on our components (<InviteFollowUpNotice
  // role="member">); only a DOM element's role must be a valid ARIA role.
  'jsx-a11y/aria-role': ['error', { ignoreNonDOM: true }],
});
// Test files mock with jest.requireActual / require() inside factories, and
// mount anonymous component factories.
frontendEslint.addOverride({ files: ['test/**'], rules: { '@typescript-eslint/no-require-imports': 'off', 'react/display-name': 'off' } });
// Heap for eslint in every project (see the no-`--fix` loop below): type-aware
// linting of the larger projects is OOM-killed (exit 137) at Node's default.
const ESLINT_NODE_OPTIONS = '--max-old-space-size=6144';
frontendEslint.eslintTask.env('NODE_OPTIONS', ESLINT_NODE_OPTIONS);
{
  const fixTask = frontend.addTask('lint:fix', {
    description: 'Run eslint with --fix (local only — CI runs `eslint` without it)',
    env: { ESLINT_USE_FLAT_CONFIG: 'false', NODE_NO_WARNINGS: '1', NODE_OPTIONS: ESLINT_NODE_OPTIONS },
  });
  const args = (frontendEslint.eslintTask.steps[0] as { execArgs?: string[] }).execArgs!;
  fixTask.execArgs([args[0], '--fix', ...args.slice(1)], { receiveArgs: true });
}
if (frontend.jest) {
  frontend.jest.config.transform = { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: { ignoreCodes: [151002] } }] };
  frontend.jest.config.moduleNameMapper = {
'^uuid$': '<rootDir>/../jest-uuid-stub.js',
    '^@/(.*)$': '<rootDir>/src/$1',
    // The shared permission catalog (api-core's dependency-free `./permissions`
    // subpath). The published file is ESM while these suites run as CommonJS, so
    // point jest at the TypeScript source and let ts-jest transpile it — the
    // frontend build itself resolves the subpath normally.
    '^@pipeline-builder/api-core/permissions$': '<rootDir>/../packages/api-core/src/types/permissions.ts',
    // Same treatment for the shared metadata-key catalog the pipeline form
    // builder's picker renders.
    '^@pipeline-builder/api-core/metadata-keys$': '<rootDir>/../packages/api-core/src/types/metadata-keys.ts',
    // …and the other browser-safe subpaths the UI imports values from.
    '^@pipeline-builder/api-core/feature-flags$': '<rootDir>/../packages/api-core/src/types/feature-flags.ts',
    '^@pipeline-builder/api-core/plugin-catalog$': '<rootDir>/../packages/api-core/src/types/plugin-catalog.ts',
    '^@pipeline-builder/pipeline-core/template$': '<rootDir>/../packages/pipeline-core/src/template/tokenizer.ts',
  };
  // Next.js's standalone build copies frontend/package.json into
  // .next/standalone/, which collides with the root in jest's haste map.
  // Ignoring `.next/` from both module and test resolution keeps the
  // haste index stable across `next build` runs.
  frontend.jest.config.modulePathIgnorePatterns = ['<rootDir>/.next/'];
  frontend.jest.config.testPathIgnorePatterns = ['/node_modules/', '<rootDir>/.next/'];
  // Frontend doesn't go through `configureEsmJest` (it's a Next/CJS project), so
  // the two hygiene settings that file applies are wired here as well:
  // `restoreMocks` (undo a `jest.spyOn` implementation after each test) and the
  // per-file `process.env` snapshot/restore. See jest-env-guard.js.
  frontend.jest.config.restoreMocks = true;
  frontend.jest.config.setupFilesAfterEnv = ['<rootDir>/test/jest.setup.ts', '<rootDir>/../jest-env-guard.js'];
}
frontend.addScripts(dockerScripts('frontend'));
// Override the shared `start`: the api-services variant preloads
// `@pipeline-builder/api-server/lib/otel-bootstrap.js` and runs `lib/index.js`,
// neither of which exists for a Next app — the image runs the standalone
// `server.js`. Pointing it at `next start` makes the script mean something and
// lets the frontend drop its api-server dependency.
frontend.addScripts({ 'start': 'next start' });
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
    // HTTP middleware (cors/helmet/rate limit) and JWT/logging come from
    // api-server/api-core; a service lists only what its own code imports.
    deps: ['mongoose@9.10.1', 'zod@4.6.5'],
  },
  {
    name: 'billing',
    deps: [
      `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
      'mongoose@9.10.1', 'zod@4.6.5',
      '@aws-sdk/client-marketplace-metering@3.1136.0', '@aws-sdk/client-marketplace-entitlement-service@3.1136.0',
      // stripe v22's CJS type entry (`export = StripeConstructor`) doesn't expose
      // the `Stripe.Subscription` namespace to NodeNext+CJS — but billing is ESM,
      // so it resolves stripe's ESM types and uses `Stripe.Subscription` natively.
      'stripe@22.6.2',
    ],
  },
  {
    name: 'plugin',
    // @aws-sdk/client-s3: S3-compatible blob storage for the uploaded build
    // context (MinIO everywhere). Staging the upload zip in object storage lets a
    // build run on a different plugin replica than the one that received it — so
    // the build scratch dir can be per-pod (no shared RWX EFS). Pinned to the
    // shared @aws-sdk version (matches the message service) to avoid perturbing
    // the dep tree.
    deps: [
      `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
      'pg@8.23.0', 'drizzle-orm@0.45.3', 'uuid@14.0.2', 'yaml@2.9.1',
      'adm-zip@0.6.1', 'yauzl@3.4.0', 'multer@2.4.0', `@pipeline-builder/ai-core@${pkg.aiCore}`, 'zod@4.6.5',
      'bullmq@6.3.8', 'ioredis@6.0.0', '@aws-sdk/client-s3@3.1136.0',
    ],
    devDeps: ['jsonwebtoken@9.0.3', '@types/jsonwebtoken@9.0.10', '@types/pg@8.23.1', '@types/adm-zip@0.5.8', '@types/yauzl@3.4.0', '@types/multer@2.2.0'],
  },
  {
    name: 'pipeline',
    deps: [
      `@pipeline-builder/pipeline-data@${pkg.pipelineData}`,
      'pg@8.23.0', 'drizzle-orm@0.45.3',
      `@pipeline-builder/ai-core@${pkg.aiCore}`, 'zod@4.6.5',
      '@aws-sdk/client-codepipeline@3.1136.0',
    ],
    devDeps: ['@types/pg@8.23.1'],
  },
  {
    name: 'message',
    // multer: multipart attachment uploads (same pin as the plugin service).
    // @aws-sdk/client-s3: S3-compatible blob storage
    // (MinIO everywhere; a real-S3 swap is an endpoint env change). Pinned to
    // the shared @aws-sdk version so it doesn't perturb the dep tree.
    // jimp: PURE-JS image resize for attachment thumbnails — deliberately NOT
    // sharp, so the alpine (musl) service image needs no native libvips binary /
    // Dockerfile change (thumbnails are occasional + small, so perf is a non-issue).
    deps: [`@pipeline-builder/pipeline-data@${pkg.pipelineData}`, 'pg@8.23.0', 'drizzle-orm@0.45.3', 'multer@2.4.0', '@aws-sdk/client-s3@3.1136.0', 'jimp@1.6.1'],
    devDeps: ['@types/pg@8.23.1', '@types/multer@2.2.0'],
  },
  {
    name: 'reporting',
    deps: [`@pipeline-builder/pipeline-data@${pkg.pipelineData}`, 'zod@4.6.5'],
  },
  {
    // "Ask" agent: read-only conversational how-to grounded in docs/*.md (Phase 1),
    // plus (later) write tools that forward the user's token to pipeline/plugin.
    // Uses ai-core for model resolution + the grounding / answer-how-to core. No DB
    // (v1 conversation is client-held) and no pipeline-data, so no pg/drizzle. The
    // service image must bundle the repo's docs/*.md (grounding corpus; ASK_DOCS_DIR).
    name: 'ask',
    deps: [`@pipeline-builder/ai-core@${pkg.aiCore}`, 'zod@4.6.5'],
    devDeps: [],
  },
  {
    name: 'compliance',
    deps: [`@pipeline-builder/pipeline-data@${pkg.pipelineData}`, 'pg@8.23.0', 'drizzle-orm@0.45.3', 'zod@4.6.5'],
    devDeps: ['@types/pg@8.23.1'],
  },
  {
    // Docker Registry token-auth issuer + image management API.
    // Hosts /token (per Distribution token-auth spec) and /api/images/*
    // for catalog/get/delete/tag-copy ops. Validates inbound Basic auth
    // against platform JWTs, the build service account, or platform user
    // creds; signs outgoing registry tokens with RS256.
    name: 'image-registry',
    deps: ['jsonwebtoken@9.0.3', 'zod@4.6.5', 'axios@1.20.0'],
    devDeps: ['@types/jsonwebtoken@9.0.10'],
  },
];

for (const svc of services) {
  const project = new FunctionProject({
...baseDefaults, parent: root,
    name: svc.name,
    deps: [...commonServiceDeps,...svc.deps],
    devDeps: [...commonServiceDevDeps,...(svc.devDeps ?? [])],
  });
  const scripts = dockerScripts(svc.name);
  if (svc.name === 'ask') {
    // The ask image bundles the docs grounding corpus. buildx's context is the
    // service dir, so stage the repo's docs/ into ./docs before the build (the
    // leading rm clears a stale copy; ./docs is gitignored). The Dockerfile then
    // `COPY docs/ /app/docs` and points ASK_DOCS_DIR at it.
    const stageDocs = 'rm -rf docs && cp -R ../../docs docs';
    project.addScripts({
      ...scripts,
      'docker:build': `${stageDocs}; ${scripts['docker:build']}`,
      'docker:publish': `${stageDocs}; ${scripts['docker:publish']}`,
    });
    project.addGitIgnore('/docs/');
  } else {
    project.addScripts(scripts);
  }
  project.eslint?.addRules(rules);
}

// =============================================================================
// Deploy contracts
// =============================================================================

/**
 * The deploy/ tree's contract tests (manifests, compose, env examples, shell
 * tooling, CI workflows) as their own Nx project. They read no service code, so
 * they belong to no service: parked in platform, they re-ran on every platform
 * change and a deploy/-only change needed a special input on platform to run
 * them at all. Here `deploy/**` is simply this project's input. Its `src/` holds
 * the shared readers the suites use (repo root, YAML docs, target lists).
 */
const deployContracts = new FunctionProject({
  ...baseDefaults, parent: root,
  name: 'deploy-contracts',
  outdir: './test/deploy-contracts',
  deps: [],
  devDeps: [typesNode, 'yaml@2.9.1'],
});
deployContracts.eslint?.addRules(rules);

// =============================================================================
// Coverage Thresholds
// =============================================================================

/**
 * Per-project coverage floors, pinned at the value MEASURED on the current tree
 * and rounded DOWN to a whole percent. This is a RATCHET, not a target: it exists
 * so coverage cannot quietly slide, and the whole-percent rounding is the
 * headroom that keeps unrelated work from tripping it.
 *
 * Raise a number when you raise coverage. NEVER lower one to make a red build
 * green — a drop means something stopped being covered, and that is the thing to
 * look at.
 *
 * The pool is EVERY source file (`collectCoverageFrom`, set below), not just the
 * files some suite happened to import — a module nobody tests counts as 0%
 * instead of silently vanishing from the report. Barrels and type-only modules
 * are excluded (noRuntimeCodeFiles), as is `src/testing/`. Re-pinned on that
 * basis 2026-09-21, with new suites for the files it exposed (pipeline-manager's
 * CLI + commands, api-server's boot helpers, billing's promotion backfill /
 * provider-config check, platform's soft-delete purge, …).
 *
 * `paths` holds the per-file floors for the security-critical and money-path
 * modules, pinned at today's value so they can only go UP.
 *
 * IMPORTANT, and not obvious: when `coverageThreshold` carries PATH-specific
 * keys, jest REMOVES those files from the `global` pool and checks them
 * separately. So a project's `global` figures below are measured over its
 * source MINUS its `paths` entries — pulling well-covered path files out of the
 * pool drags the remainder down. Do not copy a number out of a plain
 * `jest --coverage` summary into `global` here; re-measure with the path files
 * excluded, or the build fails with two figures that look irreconcilable.
 *
 * Every number is additionally CAPPED AT 95. A measured 100 becomes a floor that
 * one new uncovered branch fails, which is the "unrelated work trips it" failure
 * this ratchet is supposed to avoid.
 */
const COVERAGE_THRESHOLDS: Record<string, {
  global: Record<string, number>;
  paths?: Record<string, Record<string, number>>;
}> = {
  '@pipeline-builder/api-core': {
    global: { statements: 95, branches: 91, functions: 91, lines: 95 },
    paths: {
      // logAuditEvent — fully covered by test/log-audit-event.test.ts.
      'src/utils/audit.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
  '@pipeline-builder/api-server': {
    global: { statements: 95, branches: 88, functions: 95, lines: 95 },
  },
  '@pipeline-builder/pipeline-core': {
    global: { statements: 95, branches: 86, functions: 92, lines: 95 },
  },
  '@pipeline-builder/pipeline-data': {
    global: { statements: 94, branches: 93, functions: 87, lines: 94 },
  },
  'billing': {
    global: { statements: 93, branches: 84, functions: 90, lines: 93 },
    paths: {
      // Money paths. Stripe invoice handling — test/stripe-invoice-handlers.test.ts.
      'src/helpers/stripe-invoice-handlers.ts': { statements: 95, branches: 90, functions: 95, lines: 95 },
      // The billing ledger (ingest, reversal, summaries) — billing-ledger.test.ts
      // + billing-ledger-branches.test.ts; 100/100/100/100.
      'src/helpers/billing-ledger.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Webhook front door — test/stripe-webhook-route.test.ts drives the route
      // itself (signature refusals, the two-phase idempotency claim, the whole
      // dispatch table); measures 100/100/100/100.
      'src/routes/stripe-webhook.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Refund / dispute / void reversals + clawback — stripe-reversals(-branches).test.ts.
      'src/helpers/stripe-reversals.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Promotion grants: budget reservation, idempotency, recurring re-grant,
      // referral — promotion-engine(-branches).test.ts; 100 / 94.4 / 100.
      'src/helpers/promotion-engine.ts': { statements: 95, branches: 94, functions: 95, lines: 95 },
      'src/helpers/signup-promotions.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Discount mint / issue / grant / redeem — discounts(-routes-branches).test.ts.
      'src/routes/discounts.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      'src/routes/billing-summary.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
  'compliance': {
    global: { statements: 87, branches: 87, functions: 80, lines: 87 },
  },
  'image-registry': {
    global: { statements: 91, branches: 89, functions: 91, lines: 91 },
    paths: {
      // Docker registry token issuer — covered by test/token-route.test.ts.
      'src/routes/token.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
  'message': {
    global: { statements: 93, branches: 83, functions: 75, lines: 93 },
  },
  'pipeline': {
    global: { statements: 87, branches: 82, functions: 81, lines: 87 },
  },
  'plugin': {
    global: { statements: 95, branches: 87, functions: 94, lines: 95 },
    paths: {
      // Anonymous-submission moderation — every fail-closed publish guard
      // (community publisher, digest pin, live listing, owner, duplicate
      // version, lost claim) in test/submission-moderation-guards.test.ts.
      'src/services/ecosystem/submission-moderation.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Platform reads answer null (never a guess) — test/platform-reads.test.ts.
      'src/services/ecosystem/platform-reads.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Terminal gate-run failure fails the submission closed —
      // test/submission-build-queue.test.ts.
      'src/queue/submission-build-queue.ts': { statements: 95, branches: 94, functions: 95, lines: 95 },
    },
  },
  'quota': {
    global: { statements: 95, branches: 91, functions: 95, lines: 95 },
  },
  'reporting': {
    global: { statements: 95, branches: 89, functions: 78, lines: 95 },
  },
  'platform': {
    global: { statements: 86, branches: 83, functions: 78, lines: 86 },
    paths: {
      // SCIM provisioning (scim-filter/-render/-users/-groups/-discovery/-errors,
      // each file checked on its own) — test/scim-provisioning.test.ts covers the
      // policy (verified domains, owner/platform-admin protection, seats, the
      // removal-only downgrade, group membership) against an in-memory model
      // double; with the protocol + controller suites every file measures 100
      // statements / ≥ 95.8 branches / 100 functions.
      'src/services/scim-*.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Two-person MFA reset — test/mfa-recovery-service.test.ts; 100/100/100/100.
      'src/services/mfa-recovery.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // Opaque key → JWT exchange, plus self-rotation and sibling revoke —
      // test/token-exchange-controller.test.ts.
      'src/controllers/token-exchange.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
      // The key model behind all three: mint/list/revoke in
      // test/api-key-lifecycle.test.ts, resolution in
      // test/api-key-exchange-service.test.ts.
      'src/services/api-key-service.ts': { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
  'ask': {
    global: { statements: 94, branches: 79, functions: 93, lines: 94 },
  },
  '@pipeline-builder/ai-core': {
    global: { statements: 95, branches: 92, functions: 95, lines: 95 },
  },
  '@pipeline-builder/pipeline-events': {
    global: { statements: 95, branches: 78, functions: 95, lines: 95 },
  },
  '@pipeline-builder/pipeline-manager': {
    global: { statements: 79, branches: 84, functions: 83, lines: 79 },
  },
  'frontend': {
    global: { statements: 84, branches: 78, functions: 63, lines: 84 },
  },
};

/**
 * Source files (relative to `projectDir`) with NO runtime code of their own:
 * pure barrels (every statement an `export … from`) and type-only modules
 * (interfaces, type aliases, `import type`). There is nothing in them to cover,
 * and a type-only module that no test happens to load would otherwise count
 * every line as uncovered. Decided from the AST, not by file name —
 * pipeline-events' Lambda handler, the service entrypoints and platform's config
 * are `index.ts` files with real logic.
 */
function noRuntimeCodeFiles(projectDir: string): string[] {
  const typeOnly = (st: ts.Statement): boolean =>
    ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)
    || (ts.isImportDeclaration(st) && !!st.importClause?.isTypeOnly)
    || (ts.isExportDeclaration(st) && st.isTypeOnly)
    || ts.isEmptyStatement(st);
  const reExport = (st: ts.Statement): boolean => ts.isExportDeclaration(st) && !!st.moduleSpecifier;
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || e.name.endsWith('.d.ts')) continue;
      const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, false);
      if (sf.statements.every((st) => typeOnly(st) || reExport(st))) out.push(path.relative(projectDir, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(projectDir, 'src'));
  return out.sort();
}

/**
 * Apply the floors. jest keys a per-path threshold by a glob relative to the
 * project root, so each entry is emitted as `**\/<relative path>`.
 */
for (const project of root.subprojects) {
  const t = COVERAGE_THRESHOLDS[project.name];
  const jest = (project as { jest?: { config: Record<string, unknown> } }).jest;
  if (!t || !jest) continue;
  // Measure EVERY source file, not just the ones some test happened to import:
  // without this a module no suite loads is simply absent from the report and
  // the floors below say nothing about it. Barrels (pure re-exports) and the
  // test-helper tree are not production logic; nor are type-only modules
  // (see noRuntimeCodeFiles).
  jest.config.collectCoverageFrom = [
    project.name === 'frontend' ? 'src/**/*.{ts,tsx}' : 'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/testing/**',
    ...noRuntimeCodeFiles(project.outdir).map((f) => `!${f}`),
  ];
  jest.config.coverageThreshold = {
    global: t.global,
    ...Object.fromEntries(Object.entries(t.paths ?? {}).map(([p, v]) => [`**/${p}`, v])),
  };
}

// =============================================================================
// Lint: no `--fix` in CI
// =============================================================================

/**
 * ESLint stays on 9.x with the eslintrc config projen emits (hence
 * `ESLINT_USE_FLAT_CONFIG: 'false'` on the tasks below). ESLint 10 drops
 * eslintrc, and three plugins this rule set is built on have NO 10-compatible
 * release — their LATEST published versions cap out at 9:
 *   eslint-plugin-import@2.32.0   peer eslint: … || ^9
 *   eslint-plugin-react@7.37.5    peer eslint: … || ^9.7
 *   eslint-plugin-jsx-a11y@6.10.2 peer eslint: … || ^9
 * projen's own `Eslint` component also pins `eslint@^9` and emits only
 * `.eslintrc.json`, so there is no flat-config path through projen either.
 * (`@stylistic/eslint-plugin` and `@typescript-eslint/*` already allow ^10.)
 */

/**
 * projen's `eslint` task runs `eslint --fix`, and `test` spawns it — so CI
 * REWROTE files instead of failing on them, and a lint error that autofix could
 * "resolve" never reached a reviewer. `eslint` (and therefore `test`/`build`)
 * now only checks; `lint:fix` is the explicit local fixer.
 */
for (const project of root.subprojects) {
  const eslint = (project as TypeScriptProject).eslint;
  if (!eslint) continue;
  const step = eslint.eslintTask.steps[0] as { execArgs?: string[] } | undefined;
  const args = step?.execArgs;
  if (!args) throw new Error(`${project.name}: unexpected eslint task shape`);
  const check = args.filter((a) => a !== '--fix');
  eslint.eslintTask.reset();
  eslint.eslintTask.execArgs(check, { receiveArgs: true });
  // Type-aware linting of the larger services (api/pipeline, platform) exceeds
  // Node's default heap and is OOM-killed (exit 137) mid-run.
  eslint.eslintTask.env('NODE_OPTIONS', ESLINT_NODE_OPTIONS);
  const fixTask = project.addTask('lint:fix', {
    description: 'Run eslint with --fix (local only — CI runs `eslint` without it)',
    env: { ESLINT_USE_FLAT_CONFIG: 'false', NODE_NO_WARNINGS: '1', NODE_OPTIONS: ESLINT_NODE_OPTIONS },
  });
  fixTask.execArgs([check[0], '--fix', ...check.slice(1)], { receiveArgs: true });
}

/**
 * Projects whose TESTS read files outside their own root. Nx only hashes a
 * project's own files by default, so a change to one of these left the project
 * cached/unaffected and its drift guard unrun. Each entry lists exactly what that
 * project's suites read — a broader glob would re-run them on unrelated edits.
 * Declared as extra build/test inputs (package.json `nx` field, which nx merges
 * over nx.json's targetDefaults).
 */
const REPO_FIXTURE_INPUTS: Record<string, string[]> = {
  // Every deploy contract, plus the CI workflows and generators they check.
  'deploy-contracts': ['{workspaceRoot}/deploy/**/*', '{workspaceRoot}/.github/workflows/*', '{workspaceRoot}/scripts/*', '{workspaceRoot}/README.md', '{workspaceRoot}/index.md'],
  // org-namespace-template.test.ts: the served manifest vs the per-org templates.
  'platform': ['{workspaceRoot}/deploy/*/*/k8s/per-org/*'],
  // plugin-spec-smoke.test.ts: every catalog plugin spec.
  'plugin': ['{workspaceRoot}/deploy/plugins/**/*'],
  // The schema/RLS suites boot PGlite from the shared init script.
  '@pipeline-builder/pipeline-data': ['{workspaceRoot}/deploy/shared/postgres-init.sql'],
  // Target discovery, scaffolding and ports read most of the deploy tree.
  '@pipeline-builder/pipeline-manager': ['{workspaceRoot}/deploy/**/*'],
  // Help is generated from docs/ (help-generated-drift, permission-contract);
  // the plugin-icon suites read the curated icon set.
  'frontend': ['{workspaceRoot}/docs/**/*', '{workspaceRoot}/deploy/plugins/_icons/*'],
  // env-documented.test.ts: every env var the shared readers read is documented.
  '@pipeline-builder/api-core': ['{workspaceRoot}/docs/environment-variables.md'],
};
for (const project of root.subprojects) {
  const extra = REPO_FIXTURE_INPUTS[project.name];
  if (!extra) continue;
  const inputs = ['default', '^default', 'sharedGlobals', ...extra, '!{projectRoot}/lib/**/*', '!{projectRoot}/dist/**/*'];
  (project as TypeScriptProject).package.addField('nx', { targets: { build: { inputs }, test: { inputs } } });
}

/** A subproject's directory, relative to the repo root. */
function projectDir(name: string): string {
  const project = root.subprojects.find((p) => p.name === name);
  if (!project) throw new Error(`no subproject named ${name}`);
  return path.relative(root.outdir, project.outdir);
}

new Nx(root);
// Fills pnpmWorkspaceYamlOptions.packages — subprojects must already exist.
setWorkspacePackages(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion, imageProjects, libraryProjects });

// deploy/shared/services.txt — the one list the deploy scripts read
// (sync-image-tags.sh, service-signing-keys.sh, verify-npm-deps.sh):
//   <kind> <name> <dir>   kind = service (backend image) | frontend | library
new TextFile(root, 'deploy/shared/services.txt', {
  lines: [
    '# ~~ Generated by projen from .projenrc.ts. <kind> <name> <dir>',
    ...imageProjects.map((name) => `${name === 'frontend' ? 'frontend' : 'service'} ${name} ${projectDir(name)}`),
    ...libraryProjects.map((name) => `library ${name} ${projectDir(`@pipeline-builder/${name}`)}`),
    '', // trailing newline: `while read` drops an unterminated last line
  ],
});


root.synth();

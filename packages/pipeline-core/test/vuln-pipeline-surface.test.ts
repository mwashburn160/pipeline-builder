// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline-side vulnerability surface that lives in pipeline-core: the
 * structured synth-failure line, the run-time check's step list, the private-CA
 * bundle, the default build image (the resolved, digest-pinned pipeline-bootstrap), and the scoped key injected
 * into a step that uploads security reports.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { BuildEnvironmentVariableType, LinuxBuildImage, type IBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { bootstrapFixture } from './helpers/bootstrap-fixture.js';

const { Config } = await import('../src/config/app-config.js');
const { resolveDefaultBuildImage, createCodeBuildStep } = await import('../src/core/pipeline-helpers.js');
const { formatSynthFailure, parseSynthFailure, synthFailure, SYNTH_FAILURE_MARKER } = await import('../src/core/synth-failure.js');
const { parseRuntimeCheckSteps, isRuntimeVulnCheckEnabled, RUNTIME_VULN_CHECK_KEY } = await import('../src/core/runtime-check.js');
const { platformCaBundle, platformCaList, platformTlsVerify } = await import('../src/core/platform-tls.js');
const { PluginLookup } = await import('../src/pipeline/plugin-lookup.js');
const { UniqueId } = await import('../src/core/id-generator.js');

const DIGEST = `sha256:${'c'.repeat(64)}`;
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

describe('synth failure line', () => {
  it('round-trips through one log line, with one code for agreeing refusals', () => {
    const f = synthFailure('2 plugins can\'t be used', [
      { plugin: 'a', code: 'PLUGIN_NOT_INSTALLED', message: 'x' },
      { plugin: 'b', code: 'PLUGIN_NOT_INSTALLED', message: 'y' },
    ]);
    expect(f.code).toBe('PLUGIN_NOT_INSTALLED');
    const line = formatSynthFailure(f);
    expect(line.startsWith(`${SYNTH_FAILURE_MARKER} {`)).toBe(true);
    expect(line).not.toContain('\n');
    expect(parseSynthFailure(`2026-11-02T10:00:00Z ${line}`)).toEqual(f);
  });

  it('codes mixed refusals PLUGINS_REFUSED and a non-plugin failure SYNTH_FAILED', () => {
    expect(synthFailure('m', [{ plugin: 'a', code: 'A', message: '' }, { plugin: 'b', code: 'B', message: '' }]).code).toBe('PLUGINS_REFUSED');
    expect(synthFailure('boom').code).toBe('SYNTH_FAILED');
  });

  it('caps the payload', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ plugin: `p${i}`, code: 'C', message: 'm'.repeat(5000) }));
    const f = synthFailure('x'.repeat(5000), many);
    expect(f.plugins).toHaveLength(10);
    expect(JSON.stringify(f).length).toBeLessThan(6000);
  });

  it('rejects lines that are not failure lines', () => {
    expect(parseSynthFailure('hello')).toBeNull();
    expect(parseSynthFailure(`${SYNTH_FAILURE_MARKER} {not json`)).toBeNull();
    expect(parseSynthFailure(`${SYNTH_FAILURE_MARKER} {"message":"no code"}`)).toBeNull();
  });
});

describe('run-time check steps', () => {
  it('parses a valid list and refuses anything malformed', () => {
    expect(parseRuntimeCheckSteps(JSON.stringify([{ stepKey: 'a', imageDigest: DIGEST }]))).toEqual([{ stepKey: 'a', imageDigest: DIGEST }]);
    expect(() => parseRuntimeCheckSteps('nope')).toThrow(/not valid JSON/);
    expect(() => parseRuntimeCheckSteps('{}')).toThrow(/JSON array/);
    expect(() => parseRuntimeCheckSteps(JSON.stringify([{ stepKey: 'a', imageDigest: 'latest' }]))).toThrow(/sha256/);
  });

  it('reads the metadata flag strictly', () => {
    expect(isRuntimeVulnCheckEnabled({ [RUNTIME_VULN_CHECK_KEY]: true })).toBe(true);
    expect(isRuntimeVulnCheckEnabled({ [RUNTIME_VULN_CHECK_KEY]: 'TRUE' })).toBe(true);
    expect(isRuntimeVulnCheckEnabled({ [RUNTIME_VULN_CHECK_KEY]: 'false' })).toBe(false);
    expect(isRuntimeVulnCheckEnabled({})).toBe(false);
    expect(isRuntimeVulnCheckEnabled(undefined)).toBe(false);
  });
});

describe('PLATFORM_CA_BUNDLE', () => {
  it('is undefined when unset and refuses a value with no certificate', () => {
    expect(platformCaBundle({})).toBeUndefined();
    expect(platformCaList({})).toBeUndefined();
    expect(() => platformCaBundle({ PLATFORM_CA_BUNDLE: 'not a cert' })).toThrow(/no PEM certificate/);
  });

  it('adds the bundle on top of Node\'s roots', () => {
    const list = platformCaList({ PLATFORM_CA_BUNDLE: PEM })!;
    expect(list.at(-1)).toBe(PEM);
    expect(list.length).toBeGreaterThan(10);
  });
});

describe('PLATFORM_TLS_VERIFY', () => {
  const saved = { verify: process.env.PLATFORM_TLS_VERIFY, reject: process.env.NODE_TLS_REJECT_UNAUTHORIZED };
  afterEach(() => {
    for (const [k, v] of [['PLATFORM_TLS_VERIFY', saved.verify], ['NODE_TLS_REJECT_UNAUTHORIZED', saved.reject]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const bootstrapCommand = () => (PluginLookup.prototype.bootstrap.call({}) as { commands: string[] }).commands[0]!;

  it('verifies by default, and honours false / NODE_TLS_REJECT_UNAUTHORIZED=0 as off', () => {
    expect(platformTlsVerify({})).toBe(true);
    expect(platformTlsVerify({ PLATFORM_TLS_VERIFY: 'true' })).toBe(true);
    expect(platformTlsVerify({ PLATFORM_TLS_VERIFY: 'FALSE' })).toBe(false);
    expect(platformTlsVerify({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toBe(false);
  });

  it('refuses a value that is not true/false rather than guessing', () => {
    expect(() => platformTlsVerify({ PLATFORM_TLS_VERIFY: 'no' })).toThrow(/must be "true" or "false"/);
  });

  it('adds --no-verify-ssl to the bootstrap synth ONLY when the knob is off', () => {
    delete process.env.PLATFORM_TLS_VERIFY;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(bootstrapCommand()).not.toContain('--no-verify-ssl');
    process.env.PLATFORM_TLS_VERIFY = 'false';
    expect(bootstrapCommand()).toMatch(/ --no-verify-ssl$/);
  });
});

describe('default build image = the resolved pipeline-bootstrap, pinned like a plugin image', () => {
  const KEYS = ['IMAGE_REGISTRY_HOST', 'IMAGE_REGISTRY_PULL_HOST', 'IMAGE_REGISTRY_PULL_PORT'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.IMAGE_REGISTRY_HOST = 'registry.example.com';
    process.env.IMAGE_REGISTRY_PULL_HOST = 'registry.example.com';
    process.env.IMAGE_REGISTRY_PULL_PORT = '443';
    Config._resetForTesting();
  });
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    Config._resetForTesting();
  });

  it('pulls system/pipeline-bootstrap by its signed digest', () => {
    const image = resolveDefaultBuildImage(new Stack(new App(), 'S'), 'org1', bootstrapFixture({ digest: DIGEST }).plugin) as { imageId: string };
    expect(image.imageId).toBe(`registry.example.com/system/pipeline-bootstrap@${DIGEST}`);
  });

  it('fails the synth without a digest, on a malformed one, or outside system/', () => {
    const stack = new Stack(new App(), 'S');
    expect(() => resolveDefaultBuildImage(stack, 'org1', bootstrapFixture({ digest: '' }).plugin)).toThrow(/no signed image digest/);
    expect(() => resolveDefaultBuildImage(stack, 'org1', bootstrapFixture({ digest: 'sha256:nope' }).plugin)).toThrow(/no signed image digest/);
    expect(() => resolveDefaultBuildImage(stack, 'org1', bootstrapFixture({ repository: 'public/acme/pipeline-bootstrap' }).plugin))
      .toThrow(/BOOTSTRAP_IMAGE_UNRESOLVED/);
    expect(() => resolveDefaultBuildImage(stack, 'org1', { ...bootstrapFixture().plugin, name: 'cdk-synth' } as never))
      .toThrow(/BOOTSTRAP_IMAGE_UNRESOLVED/);
  });

  it('the default-image project has exactly a plugin step\'s Image / RegistryCredential shape', () => {
    // Phase 0: CodeBuild pulls system/pipeline-bootstrap exactly as it already
    // pulls every system plugin (cdk-synth et al.).
    const stack = new Stack(new App(), 'S');
    const uniqueId = new UniqueId({ organization: 'acme', project: 'x' });
    const bootstrap = bootstrapFixture({ digest: DIGEST }).plugin;
    const defaultBuildImage = resolveDefaultBuildImage(stack, 'org1', bootstrap);
    const base = { uniqueId, scope: stack, orgId: 'org1', pipelineScope: {}, defaultBuildImage };
    const pluginStep = createCodeBuildStep({
      ...base,
      id: 'plugin-step',
      plugin: {
        id: 'p',
        name: 'trivy',
        version: '1.0.0',
        orgId: 'system',
        buildType: 'prebuilt',
        pluginType: 'CodeBuildStep',
        imageDigest: DIGEST,
        imageRepository: 'system/trivy',
        commands: ['trivy fs .'],
        installCommands: [],
        env: {},
        metadata: {},
        secrets: [],
      },
    } as never);
    const defaultStep = createCodeBuildStep({
      ...base,
      id: 'default-step',
      plugin: {
        id: 'q',
        name: 'noop',
        version: '1.0.0',
        orgId: 'system',
        buildType: 'metadata_only',
        pluginType: 'CodeBuildStep',
        commands: ['true'],
        installCommands: [],
        env: {},
        metadata: {},
        secrets: [],
      },
    } as never);
    const envOf = (step: unknown) => (step as { buildEnvironment: { buildImage: IBuildImage } }).buildEnvironment.buildImage;
    const plugin = envOf(pluginStep);
    const dflt = envOf(defaultStep);
    expect(dflt).toBe(defaultBuildImage);
    // Same constructor, same pull-credential type, same secret, same URI shape.
    expect(dflt.constructor).toBe(plugin.constructor);
    expect(dflt.imagePullPrincipalType).toBe(plugin.imagePullPrincipalType);
    expect(dflt.imagePullPrincipalType).toBe('SERVICE_ROLE');
    expect(dflt.secretsManagerCredentials).toBe(plugin.secretsManagerCredentials);
    expect(dflt.imageId.replace('pipeline-bootstrap', '<name>')).toBe(plugin.imageId.replace('trivy', '<name>'));
  });

  it('a plugin-less step without a default build image fails the synth', () => {
    const stack = new Stack(new App(), 'S');
    expect(() => createCodeBuildStep({
      id: 'x',
      uniqueId: new UniqueId({ organization: 'acme', project: 'x' }),
      scope: stack,
      orgId: 'org1',
      pipelineScope: {},
      plugin: {
        id: 'q',
        name: 'noop',
        version: '1.0.0',
        orgId: 'system',
        buildType: 'metadata_only',
        pluginType: 'CodeBuildStep',
        commands: ['true'],
        installCommands: [],
        env: {},
        metadata: {},
        secrets: [],
      },
    } as never)).toThrow(/BOOTSTRAP_IMAGE_UNRESOLVED.*no default build image/);
  });
});

describe('security-report upload key injection', () => {
  beforeEach(() => { Config._resetForTesting(); });
  afterEach(() => { Config._resetForTesting(); });
  const plugin = (env: Record<string, string>) => ({
    id: 'p1',
    name: 'trivy',
    version: '1.0.0',
    orgId: 'system',
    buildType: 'metadata_only',
    pluginType: 'CodeBuildStep',
    commands: ['trivy fs .'],
    installCommands: [],
    env,
    metadata: {},
    secrets: [],
    primaryOutputDirectory: 'trivy-reports',
  }) as never;

  function stepEnv(env: Record<string, string>): Record<string, { value: string; type?: string }> {
    const stack = new Stack(new App(), 'S');
    const step = createCodeBuildStep({
      id: 'scan',
      uniqueId: new UniqueId({ organization: 'acme', project: 'x' }),
      plugin: plugin(env),
      scope: stack,
      orgId: 'org-1',
      pipelineScope: {},
      defaultBuildImage: LinuxBuildImage.fromCodeBuildImageId('aws/codebuild/standard:8.0'),
    } as never) as unknown as { buildEnvironment: { environmentVariables: Record<string, { value: string; type?: string }> } };
    return step.buildEnvironment.environmentVariables;
  }

  it('injects the reporting:ingest-scoped key — never the platform one — only when opted in', () => {
    const vars = stepEnv({ PB_UPLOAD_SECURITY_REPORTS: 'true' });
    expect(vars.PB_SECURITY_REPORT_KEY).toEqual({
      value: 'pipeline-builder/org-1/reporting-ingest:password',
      type: BuildEnvironmentVariableType.SECRETS_MANAGER,
    });
    expect(JSON.stringify(vars)).not.toContain('/platform');
    expect(stepEnv({ PB_UPLOAD_SECURITY_REPORTS: 'false' }).PB_SECURITY_REPORT_KEY).toBeUndefined();
  });
});

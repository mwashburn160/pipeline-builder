// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The env-driven infrastructure loaders: defaults when unset, typed overrides
 * when set — plus the registry-addressed service client.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  loadAWSConfig,
  loadComplianceConfig,
  loadDatabaseConfig,
  loadDockerConfig,
  loadObservabilityConfig,
  loadPluginBuildConfig,
} = await import('../src/config/infrastructure-config.js');
const { createServiceClient } = await import('../src/config/service-client.js');
const { InternalHttpClient } = await import('@pipeline-builder/api-core');

const touched = new Set<string>();
function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    touched.add(k);
    process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of touched) delete process.env[k];
  touched.clear();
});

describe('infrastructure config loaders', () => {
  it('fall back to their defaults when nothing is set', () => {
    expect(loadPluginBuildConfig()).toEqual({
      concurrency: 1,
      maxAttempts: 2,
      backoffDelayMs: 5_000,
      workerTimeoutMs: 10_000,
      tempDirMaxAgeMs: 14_400_000,
      dlqMaxAttempts: 3,
      dlqBackoffBaseMs: 300_000,
      dlqMaxSize: 20,
    });
    expect(loadDatabaseConfig().postgres).toMatchObject({ host: 'postgres', port: 5_432, database: 'pipeline_builder' });
    expect(loadObservabilityConfig().tracing).toEqual({ enabled: false, endpoint: 'http://localhost:4318/v1/traces' });
    expect(loadComplianceConfig()).toMatchObject({ scanSchedulerIntervalMs: 60_000, systemOrgScansEnabled: false });
    expect(loadDockerConfig()).toMatchObject({ timeoutMs: 900_000, buildkitAddr: 'unix:///run/buildkit/buildkitd.sock' });
    const aws = loadAWSConfig();
    expect(aws.lambda).toMatchObject({ runtime: 'nodejs24.x', architecture: 'arm64', reservedConcurrentExecutions: undefined });
    expect(aws.codeBuild).toEqual({ computeType: 'SMALL', defaultImage: 'pipeline-bootstrap:1.0' });
  });

  it('parse typed overrides from the environment', () => {
    setEnv({
      PLUGIN_BUILD_CONCURRENCY: '4',
      DB_PORT: '6432',
      DATABASE: 'pb_test',
      OTEL_TRACING_ENABLED: 'true',
      SYSTEM_ORG_SCANS_ENABLED: 'true',
      DOCKER_BUILD_TIMEOUT_MS: '1000',
      LAMBDA_ARCHITECTURE: 'x86_64',
      LAMBDA_RESERVED_CONCURRENCY: '7',
      CODEBUILD_COMPUTE_TYPE: 'large',
    });
    expect(loadPluginBuildConfig().concurrency).toBe(4);
    expect(loadDatabaseConfig().postgres).toMatchObject({ port: 6432, database: 'pb_test' });
    expect(loadObservabilityConfig().tracing.enabled).toBe(true);
    expect(loadComplianceConfig().systemOrgScansEnabled).toBe(true);
    expect(loadDockerConfig().timeoutMs).toBe(1000);
    const aws = loadAWSConfig();
    expect(aws.lambda).toMatchObject({ architecture: 'x86_64', reservedConcurrentExecutions: 7 });
    expect(aws.codeBuild.computeType).toBe('LARGE');
  });
});

describe('createServiceClient', () => {
  it('builds an internal client for the named service', () => {
    setEnv({ MESSAGE_SERVICE_HOST: 'message.internal', MESSAGE_SERVICE_PORT: '8080' });
    expect(createServiceClient('message')).toBeInstanceOf(InternalHttpClient);
  });
});

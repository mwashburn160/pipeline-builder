// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which credential a pipeline-registry write goes out on. The stored platform
 * key reads pipelines and plugins only (the Pipeline Automation Role), so under
 * `--store-tokens` the registration must use the separate `pipeline-register`
 * key — and when that key is absent it must SKIP, loudly, never fall back.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { PIPELINE_REGISTRATION_CAPABILITY, PIPELINE_REGISTRATION_SECRET_ENV, PIPELINE_REGISTRATION_SECRET_LEAF } from '@pipeline-builder/pipeline-core';

const getSecretValue = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/aws-secrets.js', () => ({ getSecretValue }));

const { resolveRegistrationClient, REGISTRATION_KEY_COMMAND } = await import('../src/utils/registration-client.js');
const { scopeSecretLeaf, secretNameForOrg } = await import('../src/utils/platform-secret.js');
const { ApiClient } = await import('../src/utils/api-client.js');

const config = {
  api: { baseUrl: 'https://pb.example.com', pipelineUrl: 'https://pb.example.com/api/pipelines' },
  auth: { token: 'pb_sa_platformkey' },
} as unknown as ConstructorParameters<typeof ApiClient>[0];
const platformClient = new ApiClient(config);

let warn: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[PIPELINE_REGISTRATION_SECRET_ENV];
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
const warned = () => [...warn.mock.calls.flat()].map(String).join(' ');

describe('resolveRegistrationClient', () => {
  it('uses the caller’s own client for a person’s credential (no --store-tokens)', async () => {
    await expect(resolveRegistrationClient({ client: platformClient, orgId: 'acme' })).resolves.toBe(platformClient);
    expect(getSecretValue).not.toHaveBeenCalled();
  });

  it('switches to the pipeline-register key under --store-tokens, from the injected secret name', async () => {
    process.env[PIPELINE_REGISTRATION_SECRET_ENV] = 'pipeline-builder/acme/pipeline-registry-write';
    getSecretValue.mockResolvedValue(JSON.stringify({ password: 'pb_sa_registerkey' }));

    const client = await resolveRegistrationClient({ client: platformClient, storeTokens: true, orgId: 'acme' });

    expect(getSecretValue).toHaveBeenCalledWith('pipeline-builder/acme/pipeline-registry-write', expect.anything());
    expect(client).toBeInstanceOf(ApiClient);
    expect(client).not.toBe(platformClient);
    expect(client!.getConfig().auth.token).toBe('pb_sa_registerkey');
    // Same platform, same pipeline endpoint — only the credential changed.
    expect(client!.getConfig().api).toEqual(config.api);
  });

  it('derives the secret from the org when the variable is absent (pipeline deploy --store-tokens)', async () => {
    getSecretValue.mockResolvedValue(JSON.stringify({ password: 'pb_sa_registerkey' }));
    await resolveRegistrationClient({ client: platformClient, storeTokens: true, orgId: 'acme' });
    expect(getSecretValue).toHaveBeenCalledWith(secretNameForOrg('acme', PIPELINE_REGISTRATION_SECRET_LEAF), expect.anything());
  });

  it('SKIPS with a warning naming the store-token command when the key is missing — no fallback', async () => {
    getSecretValue.mockRejectedValue(new Error('ResourceNotFoundException: Secrets Manager can’t find the specified secret.'));

    await expect(resolveRegistrationClient({ client: platformClient, storeTokens: true, orgId: 'acme' })).resolves.toBeUndefined();
    expect(warned()).toContain('SKIPPING pipeline registration');
    expect(warned()).toContain(REGISTRATION_KEY_COMMAND);
    expect(REGISTRATION_KEY_COMMAND).toContain(`--scope ${PIPELINE_REGISTRATION_CAPABILITY}`);
  });

  it('skips when the secret holds no key', async () => {
    getSecretValue.mockResolvedValue(JSON.stringify({ username: 'acme' }));
    await expect(resolveRegistrationClient({ client: platformClient, storeTokens: true, orgId: 'acme' })).resolves.toBeUndefined();
    expect(warned()).toContain(REGISTRATION_KEY_COMMAND);
  });

  // `store-token --scope pipeline_registry:write` writes the secret at the leaf
  // `scopeSecretLeaf` derives; the synth reads the leaf pipeline-core names. One
  // name, two spellings — pinned so they cannot drift apart.
  it('reads the secret store-token writes', () => {
    expect(scopeSecretLeaf(PIPELINE_REGISTRATION_CAPABILITY)).toBe(PIPELINE_REGISTRATION_SECRET_LEAF);
  });
});

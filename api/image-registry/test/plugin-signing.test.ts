// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/plugin-signing — the only use of the plugin-signing key.
 * cosign itself is stubbed (execFile); the tests pin what it is asked to do:
 * import a local PEM once, sign + attest BY DIGEST with the tlog off, hand it a
 * repository-scoped registry token, and never accept a KMS ARN.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { jest, beforeEach, afterAll, describe, it, expect } from '@jest/globals';
import { registryClientMock } from './helpers/registry-client-mock.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const execCalls: Array<{ args: string[]; env: Record<string, string | undefined>; dockerConfig?: unknown }> = [];
let execFailOn: string | null = null;
const mockExecFile = jest.fn((_file: string, args: string[], opts: { env: Record<string, string | undefined> }, cb: ExecCb) => {
  const cfgDir = opts.env.DOCKER_CONFIG;
  execCalls.push({
    args,
    env: opts.env,
    // Capture the credential while it still exists (it is removed right after).
    dockerConfig: cfgDir ? JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf-8')) : undefined,
  });
  if (execFailOn && args[0] === execFailOn) cb(new Error('exit 1'), '', 'error: signing failed\nno such key');
  else cb(null, '', '');
});
jest.unstable_mockModule('child_process', () => ({ execFile: mockExecFile }));

const mockMintToken = jest.fn<(repo: string) => Promise<string>>(async (repo) => `token-for-${repo}`);
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({ mintRepositoryPushToken: mockMintToken }));

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-signing-test-'));
const keyFile = path.join(keyDir, 'plugin-signing.key');
fs.writeFileSync(keyFile, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n');

const config = {
  registry: { host: 'registry', port: 5000, http: true, insecure: false },
  pluginSigning: { mode: 'local' as 'local' | 'kms', keyFile, kmsKeyId: '', timeoutMs: 1000 },
};
jest.unstable_mockModule('../src/config/index.js', () => ({ config }));

const {
  signPluginImage, isPluginRepository, isSha256Digest, PluginSigningError, _resetPluginSigningState,
} = await import('../src/services/plugin-signing.js');

const DIGEST = `sha256:${'f'.repeat(64)}`;
const SBOM = { spdxVersion: 'SPDX-2.3', name: 'foo' };

beforeEach(() => {
  execCalls.length = 0;
  execFailOn = null;
  jest.clearAllMocks();
  config.pluginSigning.mode = 'local';
  config.pluginSigning.kmsKeyId = '';
  config.pluginSigning.keyFile = keyFile;
  _resetPluginSigningState();
});

afterAll(() => fs.rmSync(keyDir, { recursive: true, force: true }));

describe('repository + digest shape', () => {
  it.each([
    ['system/trivy', true],
    ['org-6650f0c3a1b2c3d4e5f60718/my-plugin', true],
    ['library/pipeline-plugin-base', false],
    ['org-acme/../system/x', false],
    ['system/Upper', false],
    ['system', false],
  ])('isPluginRepository(%s) = %s', (repo, ok) => {
    expect(isPluginRepository(repo)).toBe(ok);
  });

  it('accepts only sha256 digests', () => {
    expect(isSha256Digest(DIGEST)).toBe(true);
    expect(isSha256Digest('sha512:abc')).toBe(false);
    expect(isSha256Digest('latest')).toBe(false);
  });
});

describe('signPluginImage — local key', () => {
  it('imports the PEM once, then signs and attests by digest with the tlog off', async () => {
    await signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM });
    await signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM });

    const verbs = execCalls.map((c) => c.args[0]);
    // One import for the process, then sign + attest per request.
    expect(verbs).toEqual(['import-key-pair', 'sign', 'attest', 'sign', 'attest']);

    const [imp, sign, attest] = execCalls;
    expect(imp.args).toEqual(expect.arrayContaining(['--key', keyFile]));
    const password = imp.env.COSIGN_PASSWORD;
    expect(password).toMatch(/^[0-9a-f]{64}$/);

    const ref = `registry:5000/org-acme/foo@${DIGEST}`;
    expect(sign.args).toEqual(expect.arrayContaining(['--tlog-upload=false', '--yes', '--allow-insecure-registry', '--allow-http-registry']));
    expect(sign.args[sign.args.length - 1]).toBe(ref);
    expect(sign.args[sign.args.indexOf('--key') + 1]).toMatch(/plugin-signing\.key$/);
    expect(sign.env.COSIGN_PASSWORD).toBe(password);

    expect(attest.args).toEqual(expect.arrayContaining(['--type', 'spdxjson', '--predicate', '--tlog-upload=false']));
    expect(attest.args[attest.args.length - 1]).toBe(ref);
  });

  it('hands cosign a repository-scoped bearer token, not a shared credential', async () => {
    await signPluginImage({ repository: 'system/trivy', digest: DIGEST, sbom: SBOM });
    expect(mockMintToken).toHaveBeenCalledWith('system/trivy');
    const sign = execCalls.find((c) => c.args[0] === 'sign')!;
    expect(sign.dockerConfig).toEqual({ auths: { 'registry:5000': { registrytoken: 'token-for-system/trivy' } } });
  });

  it('removes the credential and the SBOM scratch afterwards', async () => {
    await signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM });
    for (const call of execCalls.filter((c) => c.env.DOCKER_CONFIG)) {
      expect(fs.existsSync(call.env.DOCKER_CONFIG as string)).toBe(false);
    }
    const attest = execCalls.find((c) => c.args[0] === 'attest')!;
    const predicate = attest.args[attest.args.indexOf('--predicate') + 1];
    expect(fs.existsSync(predicate)).toBe(false);
  });

  it('surfaces a cosign failure as PluginSigningError with its stderr', async () => {
    execFailOn = 'sign';
    const err = await signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM }).catch((e) => e);
    expect(err).toBeInstanceOf(PluginSigningError);
    expect(err.message).toMatch(/cosign sign failed: .*no such key/);
    // Nothing is attested for an image that could not be signed.
    expect(execCalls.map((c) => c.args[0])).not.toContain('attest');
  });

  it('fails clearly when the key file is missing, and retries the import next time', async () => {
    config.pluginSigning.keyFile = path.join(keyDir, 'absent.key');
    await expect(signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM }))
      .rejects.toThrow(/signing key not found/);
    config.pluginSigning.keyFile = keyFile;
    await signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM });
    expect(execCalls.map((c) => c.args[0])).toEqual(['import-key-pair', 'sign', 'attest']);
  });

  it('refuses a non-plugin repository or malformed digest before touching cosign', async () => {
    await expect(signPluginImage({ repository: 'library/base', digest: DIGEST, sbom: SBOM })).rejects.toBeInstanceOf(PluginSigningError);
    await expect(signPluginImage({ repository: 'system/x', digest: 'sha256:zz', sbom: SBOM })).rejects.toBeInstanceOf(PluginSigningError);
    expect(execCalls).toHaveLength(0);
  });
});

describe('signPluginImage — KMS', () => {
  it('signs with the KMS key by alias and imports nothing', async () => {
    config.pluginSigning.mode = 'kms';
    config.pluginSigning.kmsKeyId = 'alias/pipeline-builder-plugin-signing';
    await signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM });
    expect(execCalls.map((c) => c.args[0])).toEqual(['sign', 'attest']);
    const sign = execCalls[0];
    expect(sign.args[sign.args.indexOf('--key') + 1]).toBe('awskms:///alias/pipeline-builder-plugin-signing');
    expect(sign.env.COSIGN_PASSWORD).toBeUndefined();
  });

  it.each([
    ['', /requires PLUGIN_SIGNING_KMS_KEY_ID/],
    ['arn:aws:kms:us-east-1:111122223333:key/abcd', /must be a KMS alias/],
  ])('refuses kms key id %p', async (id, message) => {
    config.pluginSigning.mode = 'kms';
    config.pluginSigning.kmsKeyId = id;
    await expect(signPluginImage({ repository: 'org-acme/foo', digest: DIGEST, sbom: SBOM })).rejects.toThrow(message);
    expect(execCalls).toHaveLength(0);
  });
});

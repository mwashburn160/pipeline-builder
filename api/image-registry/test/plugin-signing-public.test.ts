// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the public-namespace parts of services/plugin-signing (plugin
 * ecosystem §3.3): fresh annotated signatures in `public/*` (the previous
 * signature REPLACED, never stacked), SBOM re-attestation with `--replace`,
 * annotation-only re-signing, reading a source's SIGNED SBOM, signature
 * verification + its output parsing, and the verification key derived from the
 * local signing PEM.
 *
 * cosign is stubbed at `execFile`; the tests pin what it is asked to do.
 */

import { generateKeyPairSync, createPublicKey } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { jest, beforeEach, afterAll, describe, it, expect } from '@jest/globals';
import { registryClientMock } from './helpers/registry-client-mock.js';

type ExecCb = (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void;
type Reply = { stdout?: string; exitCode?: number | string; killed?: boolean; stderr?: string };
const execCalls: Array<{ args: string[]; env: Record<string, string | undefined>; dockerConfig?: unknown; keyFileContent?: string }> = [];
const replies = new Map<string, Reply>();
const mockExecFile = jest.fn((_file: string, args: string[], opts: { env: Record<string, string | undefined> }, cb: ExecCb) => {
  const cfgDir = opts.env.DOCKER_CONFIG;
  const keyArg = args[args.indexOf('--key') + 1];
  execCalls.push({
    args,
    env: opts.env,
    dockerConfig: cfgDir ? JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf-8')) : undefined,
    keyFileContent: keyArg && fs.existsSync(keyArg) ? fs.readFileSync(keyArg, 'utf-8') : undefined,
  });
  const reply = replies.get(args[0]) ?? {};
  if (reply.exitCode !== undefined) {
    const err = Object.assign(new Error('Command failed'), { code: reply.exitCode, killed: !!reply.killed });
    cb(err, '', reply.stderr ?? 'error: no matching signatures');
  } else {
    cb(null, reply.stdout ?? '', '');
  }
});
jest.unstable_mockModule('child_process', () => ({ execFile: mockExecFile }));

const mintRepositoryPushToken = jest.fn<(repo: string) => Promise<string>>(async (repo) => `push-token-for-${repo}`);
const mintRepositoryPullToken = jest.fn<(repo: string) => Promise<string>>(async (repo) => `pull-token-for-${repo}`);
const headManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string } | null>>();
const deleteManifest = jest.fn<(name: string, digest: string) => Promise<void>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({
  mintRepositoryPushToken, mintRepositoryPullToken, headManifest, deleteManifest,
}));

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-signing-public-test-'));
const keyFile = path.join(keyDir, 'plugin-signing.key');
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const expectedPublicPem = createPublicKey(privatePem).export({ format: 'pem', type: 'spki' }).toString();
fs.writeFileSync(keyFile, privatePem);

const config = {
  registry: { host: 'registry', port: 5000, http: false, insecure: false },
  pluginSigning: { mode: 'local' as 'local' | 'kms', keyFile, kmsKeyId: '', timeoutMs: 1000 },
};
jest.unstable_mockModule('../src/config/index.js', () => ({ config }));

const {
  signPluginImage,
  resignPublicImage,
  readSignedSbom,
  verifyPluginSignature,
  extractSpdxPredicate,
  parseVerifyOutput,
  isPluginRepository,
  isPublicRepository,
  parsePublicRepository,
  PluginSigningError,
  CosignRejectedError,
  TRUST_ANNOTATION,
  PUBLISHER_ANNOTATION,
  PUBLISHER_HANDLE_RE,
  _resetPluginSigningState,
} = await import('../src/services/plugin-signing.js');

const HEX = 'f'.repeat(64);
const DIGEST = `sha256:${HEX}`;
const SIG_TAG = `sha256-${HEX}.sig`;
const SIG_DIGEST = `sha256:${'9'.repeat(64)}`;
const PUBLIC = 'public/acme/scanner';
const SOURCE = 'org-acme/scanner';
const SBOM = { spdxVersion: 'SPDX-2.3', name: 'scanner' };
const ANNOTATIONS = { [TRUST_ANNOTATION]: 'verified', [PUBLISHER_ANNOTATION]: 'acme' };

/** One DSSE envelope line as `cosign verify-attestation` prints it. */
const envelope = (statement: unknown) =>
  JSON.stringify({ payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64') });

beforeEach(() => {
  execCalls.length = 0;
  replies.clear();
  jest.clearAllMocks();
  config.pluginSigning.mode = 'local';
  config.pluginSigning.kmsKeyId = '';
  config.pluginSigning.keyFile = keyFile;
  headManifest.mockResolvedValue(null);
  deleteManifest.mockResolvedValue(undefined);
  _resetPluginSigningState();
});

afterAll(() => fs.rmSync(keyDir, { recursive: true, force: true }));

describe('public repository shape', () => {
  it.each([
    ['public/acme/scanner', true, { handle: 'acme', name: 'scanner' }],
    ['public/acme-labs/scanner.v2', true, { handle: 'acme-labs', name: 'scanner.v2' }],
    ['public/a__b/x_y', true, { handle: 'a__b', name: 'x_y' }],
    ['public/Acme/scanner', false, null],
    ['public/acme', false, null],
    ['public/acme/x/y', false, null],
    ['public/-acme/x', false, null],
    ['public/acme./x', false, null],
    ['org-acme/scanner', false, null],
    ['xpublic/acme/scanner', false, null],
  ])('%s → public=%s', (repo, ok, parsed) => {
    expect(isPublicRepository(repo)).toBe(ok);
    expect(parsePublicRepository(repo)).toEqual(parsed);
  });

  it('counts public/<handle>/<name> as a signable plugin repository', () => {
    expect(isPluginRepository('public/acme/scanner')).toBe(true);
    expect(isPluginRepository('public/acme/x/y')).toBe(false);
  });

  it('accepts only one lowercase path component as a publisher handle', () => {
    expect(PUBLISHER_HANDLE_RE.test('acme-labs')).toBe(true);
    expect(PUBLISHER_HANDLE_RE.test('acme/labs')).toBe(false);
    expect(PUBLISHER_HANDLE_RE.test('ACME')).toBe(false);
  });
});

describe('signPluginImage in public/*', () => {
  it('drops the existing signature, then signs with the annotations and attests with --replace', async () => {
    headManifest.mockImplementation(async (_n, ref) => (ref === SIG_TAG ? { digest: SIG_DIGEST } : null));
    await signPluginImage({ repository: PUBLIC, digest: DIGEST, sbom: SBOM, annotations: ANNOTATIONS });

    expect(headManifest).toHaveBeenCalledWith(PUBLIC, SIG_TAG);
    expect(deleteManifest).toHaveBeenCalledWith(PUBLIC, SIG_DIGEST);
    const [imp, sign, attest] = execCalls;
    expect(imp.args[0]).toBe('import-key-pair');
    // The old signature is gone BEFORE cosign appends the new one.
    expect(deleteManifest.mock.invocationCallOrder[0]).toBeLessThan(mockExecFile.mock.invocationCallOrder[1]);

    expect(sign.args[0]).toBe('sign');
    expect(sign.args).toEqual(expect.arrayContaining(['-a', 'pb.trust=verified', '-a', 'pb.publisher=acme', '--tlog-upload=false']));
    expect(sign.args[sign.args.length - 1]).toBe(`registry:5000/${PUBLIC}@${DIGEST}`);
    // No insecure-registry flags against an https, verified registry.
    expect(sign.args).not.toContain('--allow-insecure-registry');
    expect(sign.dockerConfig).toEqual({ auths: { 'registry:5000': { registrytoken: `push-token-for-${PUBLIC}` } } });

    expect(attest.args[0]).toBe('attest');
    expect(attest.args).toContain('--replace');
    expect(attest.args[attest.args.length - 1]).toBe(`registry:5000/${PUBLIC}@${DIGEST}`);
    expect(mintRepositoryPullToken).not.toHaveBeenCalled();
  });

  it('signs fresh without deleting anything when there is no previous signature', async () => {
    await signPluginImage({ repository: PUBLIC, digest: DIGEST, sbom: SBOM, annotations: ANNOTATIONS });
    expect(deleteManifest).not.toHaveBeenCalled();
    expect(execCalls.map((c) => c.args[0])).toEqual(['import-key-pair', 'sign', 'attest']);
  });

  it('tolerates a signature that vanished between HEAD and DELETE (404)', async () => {
    headManifest.mockResolvedValue({ digest: SIG_DIGEST });
    deleteManifest.mockRejectedValue(Object.assign(new Error('gone'), { response: { status: 404 } }));
    await signPluginImage({ repository: PUBLIC, digest: DIGEST, sbom: SBOM, annotations: ANNOTATIONS });
    expect(execCalls.map((c) => c.args[0])).toContain('sign');
  });

  it('does not sign when the old signature could not be removed (no stacked tiers)', async () => {
    headManifest.mockResolvedValue({ digest: SIG_DIGEST });
    deleteManifest.mockRejectedValue(Object.assign(new Error('registry 500'), { response: { status: 500 } }));
    await expect(signPluginImage({ repository: PUBLIC, digest: DIGEST, sbom: SBOM, annotations: ANNOTATIONS })).rejects.toThrow('registry 500');
    expect(execCalls.map((c) => c.args[0])).not.toContain('sign');
  });

  it('leaves private repositories append-only: no signature drop, no --replace, no annotations', async () => {
    await signPluginImage({ repository: SOURCE, digest: DIGEST, sbom: SBOM });
    expect(headManifest).not.toHaveBeenCalled();
    const sign = execCalls.find((c) => c.args[0] === 'sign')!;
    const attest = execCalls.find((c) => c.args[0] === 'attest')!;
    expect(sign.args).not.toContain('-a');
    expect(attest.args).not.toContain('--replace');
  });
});

describe('resignPublicImage', () => {
  it('replaces the signature with new annotations and does NOT re-attest', async () => {
    headManifest.mockResolvedValue({ digest: SIG_DIGEST });
    await resignPublicImage(PUBLIC, DIGEST, { [TRUST_ANNOTATION]: 'official', [PUBLISHER_ANNOTATION]: 'acme' });
    expect(deleteManifest).toHaveBeenCalledWith(PUBLIC, SIG_DIGEST);
    expect(execCalls.map((c) => c.args[0])).toEqual(['import-key-pair', 'sign']);
    expect(execCalls[1].args).toEqual(expect.arrayContaining(['-a', 'pb.trust=official', '-a', 'pb.publisher=acme']));
    expect(execCalls[1].dockerConfig).toEqual({ auths: { 'registry:5000': { registrytoken: `push-token-for-${PUBLIC}` } } });
  });

  it('refuses a private repository (only public/* carries tier annotations)', async () => {
    await expect(resignPublicImage(SOURCE, DIGEST, {})).rejects.toThrow(/Not a public repository/);
    expect(execCalls).toHaveLength(0);
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('refuses a non-plugin repository or malformed digest before touching the registry', async () => {
    await expect(resignPublicImage('registry-meta/publications/acme/scanner', DIGEST, {})).rejects.toBeInstanceOf(PluginSigningError);
    await expect(resignPublicImage(PUBLIC, 'sha256:short', {})).rejects.toBeInstanceOf(PluginSigningError);
    expect(headManifest).not.toHaveBeenCalled();
  });
});

describe('readSignedSbom', () => {
  it('verifies the attestation against the DERIVED public key with a pull-only token and returns its SPDX predicate', async () => {
    replies.set('verify-attestation', { stdout: `Verification for ${SOURCE}@${DIGEST} --\n${envelope({ predicateType: 'https://spdx.dev/Document', predicate: SBOM })}\n` });
    expect(await readSignedSbom(SOURCE, DIGEST)).toEqual(SBOM);

    const [call] = execCalls;
    expect(call.args[0]).toBe('verify-attestation');
    expect(call.args).toEqual(expect.arrayContaining(['--type', 'spdxjson', '--insecure-ignore-tlog=true']));
    // The key handed to cosign is the PUBLIC half derived from the signing PEM.
    expect(call.keyFileContent).toBe(expectedPublicPem);
    expect(call.keyFileContent).not.toContain('PRIVATE');
    // Read-only: a pull token, never a push token.
    expect(mintRepositoryPullToken).toHaveBeenCalledWith(SOURCE);
    expect(mintRepositoryPushToken).not.toHaveBeenCalled();
    expect(call.dockerConfig).toEqual({ auths: { 'registry:5000': { registrytoken: `pull-token-for-${SOURCE}` } } });
    // Verification needs no private-key import.
    expect(execCalls.map((c) => c.args[0])).not.toContain('import-key-pair');
  });

  it('derives the public key once per process', async () => {
    replies.set('verify-attestation', { stdout: envelope({ predicateType: 'https://spdx.dev/Document', predicate: SBOM }) });
    await readSignedSbom(SOURCE, DIGEST);
    await readSignedSbom(SOURCE, DIGEST);
    expect(execCalls[0].args[execCalls[0].args.indexOf('--key') + 1]).toBe(execCalls[1].args[execCalls[1].args.indexOf('--key') + 1]);
  });

  it('throws CosignRejectedError when no SPDX attestation is in the output', async () => {
    replies.set('verify-attestation', { stdout: envelope({ predicateType: 'https://cyclonedx.org/bom', predicate: {} }) });
    await expect(readSignedSbom(SOURCE, DIGEST)).rejects.toBeInstanceOf(CosignRejectedError);
  });

  it('throws CosignRejectedError when cosign rejects (non-zero exit)', async () => {
    replies.set('verify-attestation', { exitCode: 1, stderr: 'no matching attestations' });
    const err = await readSignedSbom(SOURCE, DIGEST).catch((e) => e);
    expect(err).toBeInstanceOf(CosignRejectedError);
    expect(err.message).toMatch(/cosign verify-attestation failed: no matching attestations/);
  });

  it.each([
    ['cosign missing (ENOENT)', { exitCode: 'ENOENT' }],
    ['a timeout kill', { exitCode: 1, killed: true }],
  ])('treats %s as infrastructure, not a rejection', async (_label, reply) => {
    replies.set('verify-attestation', reply);
    const err = await readSignedSbom(SOURCE, DIGEST).catch((e) => e);
    expect(err).toBeInstanceOf(PluginSigningError);
    expect(err).not.toBeInstanceOf(CosignRejectedError);
  });

  it('fails clearly when the signing key is missing', async () => {
    config.pluginSigning.keyFile = path.join(keyDir, 'absent.key');
    await expect(readSignedSbom(SOURCE, DIGEST)).rejects.toThrow(/signing key not found/);
    expect(execCalls).toHaveLength(0);
  });

  it('fails clearly when the signing key is not a readable private key', async () => {
    const bad = path.join(keyDir, 'bad.key');
    fs.writeFileSync(bad, '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n');
    config.pluginSigning.keyFile = bad;
    await expect(readSignedSbom(SOURCE, DIGEST)).rejects.toThrow(/is not a readable private key/);
  });

  it('verifies with the KMS alias in kms mode', async () => {
    config.pluginSigning.mode = 'kms';
    config.pluginSigning.kmsKeyId = 'alias/plugin-signing';
    replies.set('verify-attestation', { stdout: envelope({ predicateType: 'https://spdx.dev/Document', predicate: SBOM }) });
    await readSignedSbom(SOURCE, DIGEST);
    expect(execCalls[0].args[execCalls[0].args.indexOf('--key') + 1]).toBe('awskms:///alias/plugin-signing');
  });

  it('adds the insecure/http registry flags when the registry is configured that way', async () => {
    config.registry.http = true;
    try {
      replies.set('verify-attestation', { stdout: envelope({ predicateType: 'https://spdx.dev/Document', predicate: SBOM }) });
      await readSignedSbom(SOURCE, DIGEST);
      expect(execCalls[0].args).toEqual(expect.arrayContaining(['--allow-insecure-registry', '--allow-http-registry']));
    } finally {
      config.registry.http = false;
    }
  });
});

describe('extractSpdxPredicate', () => {
  it('returns the LAST SPDX predicate (a rebuild re-attests; cosign lists oldest first)', () => {
    const out = [
      'Verification for x --',
      envelope({ predicateType: 'https://spdx.dev/Document', predicate: { name: 'old' } }),
      envelope({ predicateType: 'https://spdx.dev/Document', predicate: { name: 'new' } }),
    ].join('\n');
    expect(extractSpdxPredicate(out)).toEqual({ name: 'new' });
  });

  it.each([
    ['empty output', ''],
    ['non-JSON noise', 'The following checks were performed\n{not json'],
    ['an envelope without a payload', JSON.stringify({ payloadType: 'x' })],
    ['a payload that is not JSON', JSON.stringify({ payload: Buffer.from('nope').toString('base64') })],
    ['a non-SPDX predicate', envelope({ predicateType: 'https://slsa.dev/provenance/v1', predicate: { a: 1 } })],
    ['an SPDX statement with no predicate object', envelope({ predicateType: 'https://spdx.dev/Document', predicate: 'string' })],
  ])('returns null for %s', (_label, out) => {
    expect(extractSpdxPredicate(out)).toBeNull();
  });
});

describe('verifyPluginSignature + parseVerifyOutput', () => {
  const payload = (ref: string, digest: string, optional: unknown) => ({
    critical: { identity: { 'docker-reference': ref }, image: { 'docker-manifest-digest': digest }, type: 'cosign container image signature' },
    optional,
  });

  it('returns every verified payload with its annotations, using a pull-only token', async () => {
    replies.set('verify', {
      stdout: `\nVerification for ${PUBLIC}@${DIGEST} --\n${JSON.stringify([payload(`registry:5000/${PUBLIC}`, DIGEST, ANNOTATIONS)])}\n`,
    });
    expect(await verifyPluginSignature(PUBLIC, DIGEST)).toEqual([
      { dockerReference: `registry:5000/${PUBLIC}`, manifestDigest: DIGEST, annotations: ANNOTATIONS },
    ]);
    expect(execCalls[0].args).toEqual(expect.arrayContaining(['verify', '--output', 'json', '--insecure-ignore-tlog=true']));
    expect(mintRepositoryPullToken).toHaveBeenCalledWith(PUBLIC);
    expect(mintRepositoryPushToken).not.toHaveBeenCalled();
  });

  it('returns [] when cosign rejects (nothing verifies)', async () => {
    replies.set('verify', { exitCode: 10 });
    expect(await verifyPluginSignature(PUBLIC, DIGEST)).toEqual([]);
  });

  it('throws on an infrastructure failure rather than reporting "unsigned"', async () => {
    replies.set('verify', { exitCode: 'ETIMEDOUT' });
    await expect(verifyPluginSignature(PUBLIC, DIGEST)).rejects.toBeInstanceOf(PluginSigningError);
  });

  it('refuses a non-plugin repository before running cosign', async () => {
    await expect(verifyPluginSignature('registry-meta/x/y', DIGEST)).rejects.toBeInstanceOf(PluginSigningError);
    expect(execCalls).toHaveLength(0);
  });

  it.each([
    ['no JSON array', 'Verification failed'],
    ['a truncated array', '[{"critical":'],
    ['an empty array', '[]'],
  ])('parses %s as no signatures', (_label, out) => {
    expect(parseVerifyOutput(out)).toEqual([]);
  });

  it('keeps only string annotations and tolerates missing / malformed fields', () => {
    const out = JSON.stringify([
      null,
      { optional: null },
      { critical: { identity: { 'docker-reference': 42 }, image: {} }, optional: { 'pb.trust': 'official', 'count': 3, 'nested': { a: 1 } } },
    ]);
    expect(parseVerifyOutput(out)).toEqual([
      { annotations: {} },
      { annotations: {} },
      { annotations: { 'pb.trust': 'official' } },
    ]);
  });
});

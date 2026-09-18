// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ES256 user-token signing service: both signers, the published key set, the
 * `/.well-known/jwks.json` route, and the boot-time failure modes.
 *
 * What makes this worth a suite of its own: platform is the ONLY minter of user
 * tokens in the fleet, and the two signers must produce byte-compatible output.
 * The local signer hands Node's raw `r || s` signature straight through; the KMS
 * signer gets ASN.1 DER back and has to convert it. A bug on either path yields
 * tokens that verify nowhere, which no other test would catch — every other
 * suite installs keys through the test seam and never exercises a real signer.
 */

import crypto from 'crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import type { Request, Response } from 'express';

const signingConfig: Record<string, unknown> = { mode: 'local' };
const jwtConfig: Record<string, unknown> = { secret: 'service-secret', algorithm: 'HS256', signing: signingConfig };
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { jwt: jwtConfig } } }));

const {
  initTokenSigning, publishedJwks, signUserJwt, verifyUserJwtSync, currentSigningKid,
  isRetiringKeyPublished, _resetTokenSigningForTests,
} = await import('../src/services/token-signing/index.js');
const { _setKmsClientForTests } = await import('../src/services/token-signing/kms-signer.js');
const { jwksHandler } = await import('../src/routes/jwks.js');
const { USER_TOKEN_ALGORITHM, publicJwkFrom } = await import('@pipeline-builder/api-core');

/** A PKCS#8 PEM on disk, exactly what deploy/bin/token-signing-keys.sh writes. */
function writeKeyFile(dir: string, name: string): { path: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const path = join(dir, name);
  writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
  return { path, publicKey };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-signing-'));
  Object.assign(signingConfig, {
    mode: 'local', keyFile: undefined, previousKeyFile: undefined, kmsKeyId: undefined, kmsPreviousKeyId: undefined,
  });
  Object.assign(jwtConfig, { issuer: undefined, audience: undefined });
  _resetTokenSigningForTests();
  _setKmsClientForTests(undefined);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => _resetTokenSigningForTests());

describe('local (file) signer', () => {
  it('signs a verifiable ES256 token and names its key in the header', async () => {
    const key = writeKeyFile(dir, 'token-signing.key');
    signingConfig.keyFile = key.path;
    await initTokenSigning();

    const token = await signUserJwt({ sub: 'u1', type: 'access' }, { expiresIn: 60 });
    const [header] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf-8'))).toEqual({
      alg: USER_TOKEN_ALGORITHM, typ: 'JWT', kid: publicJwkFrom(key.publicKey).kid,
    });
    expect(verifyUserJwtSync<{ sub: string }>(token).sub).toBe('u1');
  });

  it('stamps iat/exp, and iss/aud only when configured', async () => {
    signingConfig.keyFile = writeKeyFile(dir, 'token-signing.key').path;
    await initTokenSigning();

    const plain = verifyUserJwtSync<{ iat: number; exp: number; iss?: string; aud?: string }>(
      await signUserJwt({ sub: 'u1' }, { expiresIn: 90 }),
    );
    expect(plain.exp - plain.iat).toBe(90);
    expect(plain.iss).toBeUndefined();
    expect(plain.aud).toBeUndefined();

    Object.assign(jwtConfig, { issuer: 'pipeline-builder', audience: 'pb-api' });
    const pinned = verifyUserJwtSync<{ iss: string; aud: string }>(await signUserJwt({ sub: 'u1' }, { expiresIn: 90 }));
    expect(pinned).toMatchObject({ iss: 'pipeline-builder', aud: 'pb-api' });
  });

  it('derives the kid from the KEY, so the same PEM always publishes the same id', async () => {
    const key = writeKeyFile(dir, 'token-signing.key');
    signingConfig.keyFile = key.path;
    await initTokenSigning();
    const first = await currentSigningKid();

    _resetTokenSigningForTests();
    await initTokenSigning();
    expect(await currentSigningKid()).toBe(first);
  });

  it('publishes the retiring key for verification but NEVER signs with it', async () => {
    const current = writeKeyFile(dir, 'token-signing.key');
    const retiring = writeKeyFile(dir, 'token-signing-previous.key');
    signingConfig.keyFile = current.path;
    signingConfig.previousKeyFile = retiring.path;
    await initTokenSigning();

    const jwks = await publishedJwks();
    expect(jwks.keys.map((k) => k.kid)).toEqual([
      publicJwkFrom(current.publicKey).kid,
      publicJwkFrom(retiring.publicKey).kid,
    ]);
    // New tokens carry the CURRENT kid — a retiring key is verification-only.
    const token = await signUserJwt({ sub: 'u1' }, { expiresIn: 60 });
    const { kid } = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf-8'));
    expect(kid).toBe(publicJwkFrom(current.publicKey).kid);
    expect(isRetiringKeyPublished()).toBe(true);
  });

  it('refuses to start without a key file configured', async () => {
    await expect(initTokenSigning()).rejects.toThrow(/TOKEN_SIGNING_KEY_FILE is required/);
  });

  it('refuses to start when the key file is missing', async () => {
    signingConfig.keyFile = join(dir, 'nope.key');
    await expect(initTokenSigning()).rejects.toThrow(/could not be read/);
  });

  it('refuses to start on a key that is not EC P-256', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const path = join(dir, 'rsa.key');
    writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
    signingConfig.keyFile = path;
    await expect(initTokenSigning()).rejects.toThrow(/must be an EC P-256 key/);
  });

  it('does not cache a failed init — a transient failure must not poison later attempts', async () => {
    signingConfig.keyFile = join(dir, 'later.key');
    await expect(initTokenSigning()).rejects.toThrow();
    const key = writeKeyFile(dir, 'later.key');
    await initTokenSigning();
    expect(await currentSigningKid()).toBe(publicJwkFrom(key.publicKey).kid);
  });
});

describe('KMS signer', () => {
  /**
   * A KMS stand-in: `GetPublicKey` returns DER SPKI and `Sign` returns an ASN.1
   * DER signature — exactly the two shapes the real service returns, which is
   * what the DER → JOSE conversion exists for.
   */
  function fakeKms(keys: Record<string, { key: crypto.KeyObject; publicKey: crypto.KeyObject }>, overrides: { keySpec?: string; keyUsage?: string } = {}) {
    const calls: Array<{ op: string; keyId: string }> = [];
    const commands = {
      GetPublicKeyCommand: class { constructor(public input: { KeyId: string }) {} },
      SignCommand: class { constructor(public input: { KeyId: string; Message: Uint8Array }) {} },
    };
    const client = {
      async send(command: any) {
        const keyId = command.input.KeyId as string;
        const entry = keys[keyId];
        if (!entry) throw new Error(`no such key ${keyId}`);
        if (command instanceof commands.GetPublicKeyCommand) {
          calls.push({ op: 'GetPublicKey', keyId });
          return {
            PublicKey: new Uint8Array(entry.publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
            KeySpec: overrides.keySpec ?? 'ECC_NIST_P256',
            KeyUsage: overrides.keyUsage ?? 'SIGN_VERIFY',
          };
        }
        calls.push({ op: 'Sign', keyId });
        return {
          Signature: new Uint8Array(crypto.sign('sha256', Buffer.from(command.input.Message), { key: entry.key, dsaEncoding: 'der' })),
        };
      },
    };
    _setKmsClientForTests({ client: client as never, commands: commands as never });
    return calls;
  }

  function kmsKey() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { key: privateKey, publicKey };
  }

  it('signs a verifiable token, converting KMS DER into a JOSE signature', async () => {
    const key = kmsKey();
    const calls = fakeKms({ 'alias/pb-signing': key });
    Object.assign(signingConfig, { mode: 'kms', kmsKeyId: 'alias/pb-signing' });
    await initTokenSigning();

    const token = await signUserJwt({ sub: 'u1', type: 'access' }, { expiresIn: 60 });
    // The whole point: a token minted through KMS verifies with the SAME
    // verifier every service uses for a locally-signed one.
    expect(verifyUserJwtSync<{ sub: string }>(token).sub).toBe('u1');
    expect(calls.filter((c) => c.op === 'Sign')).toHaveLength(1);
  });

  it('fetches the public key ONCE, at boot — verification never calls KMS', async () => {
    const calls = fakeKms({ 'alias/pb-signing': kmsKey() });
    Object.assign(signingConfig, { mode: 'kms', kmsKeyId: 'alias/pb-signing' });
    await initTokenSigning();

    const token = await signUserJwt({ sub: 'u1' }, { expiresIn: 60 });
    verifyUserJwtSync(token);
    await publishedJwks();
    expect(calls.filter((c) => c.op === 'GetPublicKey')).toHaveLength(1);
  });

  it('publishes both kids during a rotation and signs only with the current one', async () => {
    const current = kmsKey();
    const retiring = kmsKey();
    const calls = fakeKms({ 'alias/pb-signing': current, 'alias/pb-signing-old': retiring });
    Object.assign(signingConfig, { mode: 'kms', kmsKeyId: 'alias/pb-signing', kmsPreviousKeyId: 'alias/pb-signing-old' });
    await initTokenSigning();

    expect((await publishedJwks()).keys.map((k) => k.kid)).toEqual([
      publicJwkFrom(current.publicKey).kid,
      publicJwkFrom(retiring.publicKey).kid,
    ]);
    await signUserJwt({ sub: 'u1' }, { expiresIn: 60 });
    expect(calls.filter((c) => c.op === 'Sign').map((c) => c.keyId)).toEqual(['alias/pb-signing']);
  });

  it('refuses to start without a key id', async () => {
    Object.assign(signingConfig, { mode: 'kms' });
    await expect(initTokenSigning()).rejects.toThrow(/TOKEN_SIGNING_KMS_KEY_ID is required/);
  });

  it('refuses a key of the wrong spec or usage', async () => {
    fakeKms({ 'alias/pb-signing': kmsKey() }, { keySpec: 'RSA_2048' });
    Object.assign(signingConfig, { mode: 'kms', kmsKeyId: 'alias/pb-signing' });
    await expect(initTokenSigning()).rejects.toThrow(/ECC_NIST_P256/);

    _resetTokenSigningForTests();
    fakeKms({ 'alias/pb-signing': kmsKey() }, { keyUsage: 'ENCRYPT_DECRYPT' });
    await expect(initTokenSigning()).rejects.toThrow(/SIGN_VERIFY/);
  });

  it('surfaces a GetPublicKey failure as a startup error', async () => {
    fakeKms({});
    Object.assign(signingConfig, { mode: 'kms', kmsKeyId: 'alias/pb-signing' });
    await expect(initTokenSigning()).rejects.toThrow(/KMS GetPublicKey failed/);
  });
});

describe('cross-signer compatibility', () => {
  it('a token from the KMS signer verifies against the file signer holding the same key', async () => {
    // The two implementations must be interchangeable: an install can move
    // between them without invalidating anything, because the kid is the key's
    // thumbprint and the token format is identical.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const commands = {
      GetPublicKeyCommand: class { constructor(public input: { KeyId: string }) {} },
      SignCommand: class { constructor(public input: { KeyId: string; Message: Uint8Array }) {} },
    };
    _setKmsClientForTests({
      commands: commands as never,
      client: {
        async send(command: any) {
          if (command instanceof commands.GetPublicKeyCommand) {
            return { PublicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }) as Buffer), KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' };
          }
          return { Signature: new Uint8Array(crypto.sign('sha256', Buffer.from(command.input.Message), { key: privateKey, dsaEncoding: 'der' })) };
        },
      } as never,
    });

    Object.assign(signingConfig, { mode: 'kms', kmsKeyId: 'alias/pb-signing' });
    await initTokenSigning();
    const kmsToken = await signUserJwt({ sub: 'u1' }, { expiresIn: 60 });

    // Same key, now read from a PEM by the local signer.
    const path = join(dir, 'same.key');
    writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
    _resetTokenSigningForTests();
    Object.assign(signingConfig, { mode: 'local', keyFile: path, kmsKeyId: undefined });
    await initTokenSigning();

    expect(verifyUserJwtSync<{ sub: string }>(kmsToken).sub).toBe('u1');
  });
});

describe('verifyUserJwtSync', () => {
  beforeEach(async () => {
    signingConfig.keyFile = writeKeyFile(dir, 'token-signing.key').path;
    await initTokenSigning();
  });

  it('rejects a token signed by a key platform does not hold', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const body = Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: await currentSigningKid() })).toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    expect(() => verifyUserJwtSync(`${header}.${body}.${sig.toString('base64url')}`)).toThrow();
  });

  it('rejects an unknown kid, a missing kid and a non-ES256 alg', async () => {
    const token = await signUserJwt({ sub: 'u1' }, { expiresIn: 60 });
    const [, body, sig] = token.split('.');
    const reheader = (header: object) => `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${body}.${sig}`;
    expect(() => verifyUserJwtSync(reheader({ alg: 'ES256', kid: 'nope' }))).toThrow(/Unknown signing key/);
    expect(() => verifyUserJwtSync(reheader({ alg: 'ES256' }))).toThrow(/must be signed with ES256/);
    expect(() => verifyUserJwtSync(reheader({ alg: 'HS256', kid: 'nope' }))).toThrow(/must be signed with ES256/);
  });

  it('refuses to verify anything before the keys are loaded', async () => {
    const token = await signUserJwt({ sub: 'u1' }, { expiresIn: 60 });
    _resetTokenSigningForTests();
    expect(() => verifyUserJwtSync(token)).toThrow(/keys are not loaded/);
  });
});

describe('GET /.well-known/jwks.json', () => {
  /** Minimal Express double — enough for the handler's set/json/status calls. */
  function capture() {
    const out = { status: 200, headers: {} as Record<string, string>, body: undefined as any };
    const res = {
      set: (name: string, value: string) => { out.headers[name.toLowerCase()] = value; return res; },
      status: (code: number) => { out.status = code; return res; },
      json: (body: unknown) => { out.body = body; return res; },
    } as unknown as Response;
    return { out, res };
  }

  const call = async () => {
    const { out, res } = capture();
    await jwksHandler({} as Request, res);
    return out;
  };

  it('serves the published key set, public and cacheable', async () => {
    const current = writeKeyFile(dir, 'token-signing.key');
    const retiring = writeKeyFile(dir, 'token-signing-previous.key');
    signingConfig.keyFile = current.path;
    signingConfig.previousKeyFile = retiring.path;
    await initTokenSigning();

    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=600');
    // Shape: a bare `keys` array of ES256 P-256 public keys, nothing else — no
    // success envelope, because this is a standard document other tooling reads.
    expect(Object.keys(res.body)).toEqual(['keys']);
    expect(res.body.keys).toHaveLength(2);
    for (const jwk of res.body.keys) {
      expect(Object.keys(jwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
      expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256' });
      // No private material, ever.
      expect(jwk).not.toHaveProperty('d');
    }
    expect(res.body.keys[0].kid).toBe(publicJwkFrom(current.publicKey).kid);
  });

  it('answers 503 when the keys cannot be loaded, rather than an empty set', async () => {
    // An empty document would make every verifier reject every token as an
    // unknown kid, with no signal that the cause is at this end.
    signingConfig.keyFile = join(dir, 'missing.key');
    expect((await call()).status).toBe(503);
  });
});

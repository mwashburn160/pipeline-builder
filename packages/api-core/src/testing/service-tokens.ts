// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test helper for the PER-SERVICE internal-token chain (#14) in its REAL,
 * `configured` shape: private keys on disk, one public bundle, `SERVICE_NAME`
 * naming the signer.
 *
 * Most suites need none of this — with no `SERVICE_SIGNING_KEY_FILE` the signer
 * runs in ephemeral mode and a single process can mint and verify its own
 * service tokens with zero setup (see `services/service-keys.ts`). This helper
 * exists for the tests that must exercise the DEPLOYED configuration: the
 * mesh-less internal-route test, and the key-rotation test. It writes the same
 * files `deploy/bin/service-signing-keys.sh` generates, so what the tests verify
 * is what the deploy produces.
 *
 * ```ts
 * const keys = installTestServiceKeys(['billing', 'compliance']);
 * const token = keys.sign('billing', { role: 'member', orgId: 'o1' });
 * // …
 * keys.uninstall();
 * ```
 */

import crypto, { type KeyObject } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _resetServiceKeysForTests, signServiceJwt, type ServiceKeyBundle } from '../services/service-keys.js';
import { publicJwkFrom, type PublicJwk } from '../utils/jwk.js';

/** One generated service keypair, in the forms a test needs. */
export interface TestServiceKey {
  serviceName: string;
  kid: string;
  privateKey: KeyObject;
  jwk: PublicJwk;
  /** Path of the PKCS#8 PEM written for this service. */
  keyFile: string;
}

/** Handle over an installed set of per-service keys. */
export interface TestServiceKeysHandle {
  keys: Map<string, TestServiceKey>;
  /** Directory holding the key files and `bundle.json`. */
  dir: string;
  bundleFile: string;
  /** Act AS `serviceName` for subsequent `signServiceToken` calls. */
  becomeService(serviceName: string): void;
  /** Mint a well-formed internal token for `serviceName`, as that service would. */
  sign(serviceName: string, claims?: Record<string, unknown>, expiresInSeconds?: number): string;
  /**
   * Mint a token whose `sub` names `subjectService` but which is SIGNED with
   * `signerService`'s key — the cross-service forgery the per-service keys make
   * detectable. Every verifier must refuse it.
   */
  signAs(signerService: string, subjectService: string, claims?: Record<string, unknown>): string;
  /** Rewrite `bundle.json` with only the named services' keys (rotation / trust changes). */
  publish(serviceNames: string[]): void;
  /**
   * Rewrite `bundle.json` from an explicit service → keys map, so a test can
   * publish TWO keys for one service (the rotation-overlap shape) or publish a
   * key under a name it was not generated for.
   */
  publishKeys(keysByService: Record<string, TestServiceKey[]>): void;
  /** Restore the previous environment and delete the generated files. */
  uninstall(): void;
}

/** The claim block a SERVICE principal must carry to satisfy `hasValidIdentityClaims`. */
export function testServiceIdentityClaims(serviceName: string, role: 'owner' | 'admin' | 'member' = 'member'): Record<string, unknown> {
  return {
    username: `${serviceName}-service`,
    email: `${serviceName}@internal`,
    principalType: 'service',
    token_use: 'access',
    type: 'access',
    role,
    isAdmin: role === 'owner' || role === 'admin',
  };
}

/** base64url of a JSON value, the JWS way. */
function b64uJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

/**
 * Generate a keypair per name, write the private keys and the public bundle to a
 * temp directory, and point `SERVICE_SIGNING_KEY_FILE` / `SERVICE_KEY_BUNDLE_FILE`
 * / `SERVICE_NAME` at them. The first name becomes this process's identity.
 */
export function installTestServiceKeys(serviceNames: string[]): TestServiceKeysHandle {
  if (serviceNames.length === 0) throw new Error('installTestServiceKeys needs at least one service name');
  const dir = mkdtempSync(join(tmpdir(), 'pb-service-keys-'));
  const bundleFile = join(dir, 'bundle.json');
  const previous = {
    SERVICE_NAME: process.env.SERVICE_NAME,
    SERVICE_SIGNING_KEY_FILE: process.env.SERVICE_SIGNING_KEY_FILE,
    SERVICE_KEY_BUNDLE_FILE: process.env.SERVICE_KEY_BUNDLE_FILE,
  };

  const keys = new Map<string, TestServiceKey>();
  for (const serviceName of serviceNames) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const keyFile = join(dir, `${serviceName}.key`);
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'utf8');
    const jwk = publicJwkFrom(publicKey);
    keys.set(serviceName, { serviceName, kid: jwk.kid, privateKey, jwk, keyFile });
  }

  const writeBundleFrom = (keysByService: Record<string, TestServiceKey[]>): void => {
    const bundle: ServiceKeyBundle = { services: {} };
    for (const [name, entries] of Object.entries(keysByService)) {
      bundle.services[name] = { keys: entries.map((k) => k.jwk) };
    }
    writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    _resetServiceKeysForTests();
  };

  const writeBundle = (names: string[]): void => {
    writeBundleFrom(Object.fromEntries(names.map((name) => {
      const key = keys.get(name);
      if (!key) throw new Error(`No generated key for ${name}`);
      return [name, [key]];
    })));
  };

  const become = (serviceName: string): void => {
    const key = keys.get(serviceName);
    if (!key) throw new Error(`No generated key for ${serviceName}`);
    process.env.SERVICE_NAME = serviceName;
    process.env.SERVICE_SIGNING_KEY_FILE = key.keyFile;
    _resetServiceKeysForTests();
  };

  process.env.SERVICE_KEY_BUNDLE_FILE = bundleFile;
  writeBundle(serviceNames);
  become(serviceNames[0]);

  return {
    keys,
    dir,
    bundleFile,
    becomeService: become,
    sign(serviceName, claims = {}, expiresInSeconds = 300) {
      become(serviceName);
      return signServiceJwt({ ...testServiceIdentityClaims(serviceName), ...claims }, { serviceName, expiresInSeconds });
    },
    signAs(signerService, subjectService, claims = {}) {
      // Deliberately bypasses `signServiceJwt`, which refuses to sign for a name
      // it does not hold — the point here is to produce the forgery a verifier
      // must catch, not to reproduce it through the legitimate signer.
      const signer = keys.get(signerService);
      if (!signer) throw new Error(`No generated key for ${signerService}`);
      const now = Math.floor(Date.now() / 1000);
      const body = {
        ...testServiceIdentityClaims(subjectService),
        ...claims,
        sub: `service:${subjectService}`,
        iat: now,
        exp: now + 300,
      };
      const signingInput = `${b64uJson({ alg: 'ES256', typ: 'JWT', kid: signer.kid })}.${b64uJson(body)}`;
      const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf-8'), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' });
      return `${signingInput}.${signature.toString('base64url')}`;
    },
    publish: writeBundle,
    publishKeys: writeBundleFrom,
    uninstall() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      _resetServiceKeysForTests();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

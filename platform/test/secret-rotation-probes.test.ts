// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform-only halves of the `secret_rotation_previous_set` gauge
 * (docs/runbooks/secret-rotation.md). api-core registers `JWT_SECRET` (the
 * internal service-token secret); if these three probes are missing, a
 * half-finished rotation of the ES256 user-token signing key, the at-rest master
 * key or the alert-relay bearer is invisible and the
 * SecretRotationPreviousLingering alert never fires for it.
 *
 * `TOKEN_SIGNING_KEY` has no `*_PREVIOUS` env value to read — its overlap is a
 * RETIRING `kid` still published in the JWKS — so its probe asks the signer.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

const instances: Array<{ id: string; token: string; previousToken?: string }> = [];
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ alertWebhook: { get instances() { return instances; } } }));

const { previousSecretStates } = await import('@pipeline-builder/api-core');
const { registerPlatformSecretRotationProbes } = await import('../src/observability/secret-rotation.js');
const { _setTokenSigningKeysForTests } = await import('../src/services/token-signing/index.js');
const { generateSigningKey } = await import('./helpers/signing.js');

const ENV = ['SECRET_ENCRYPTION_KEY_PREVIOUS'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const stateOf = (secret: string) => previousSecretStates().find((s) => s.secret === secret)?.previousSet;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  instances.length = 0;
  _setTokenSigningKeysForTests({ current: generateSigningKey(), retiring: [] });
  registerPlatformSecretRotationProbes();
});

describe('platform secret-rotation probes', () => {
  it('reports every platform-held secret as not rotating by default', () => {
    instances.push({ id: 'alertmanager', token: 'tok' });
    expect(stateOf('TOKEN_SIGNING_KEY')).toBe(false);
    expect(stateOf('SECRET_ENCRYPTION_KEY')).toBe(false);
    expect(stateOf('ALERT_WEBHOOK_INSTANCE_TOKEN')).toBe(false);
  });

  it('reports the signing key as rotating while a RETIRING kid is still published', () => {
    const retiring = generateSigningKey({ canSign: false });
    _setTokenSigningKeysForTests({
      current: generateSigningKey(),
      retiring: [{ kid: retiring.kid, publicKey: retiring.publicKey }],
    });
    expect(stateOf('TOKEN_SIGNING_KEY')).toBe(true);
  });

  it('tracks the encryption overlap env var', () => {
    expect(stateOf('SECRET_ENCRYPTION_KEY')).toBe(false);
    process.env.SECRET_ENCRYPTION_KEY_PREVIOUS = 'old-key';
    expect(stateOf('SECRET_ENCRYPTION_KEY')).toBe(true);
  });

  it('tracks a relay instance carrying a previousToken', () => {
    instances.push({ id: 'alertmanager', token: 'tok-new', previousToken: 'tok-old' });
    expect(stateOf('ALERT_WEBHOOK_INSTANCE_TOKEN')).toBe(true);
  });
});

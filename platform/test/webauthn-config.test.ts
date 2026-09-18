// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WebAuthn relying-party configuration: derivation from `PLATFORM_FRONTEND_URL`
 * and the boot-time rules that stop a deploy from orphaning every passkey.
 *
 * These are cheap assertions about an expensive mistake: a wrong RP ID is not
 * recoverable — credentials registered under it simply stop being offered, and
 * no migration can move them.
 */

import { describe, it, expect } from '@jest/globals';
import { assertWebAuthnConfig, resolveWebAuthnConfig } from '../src/config/webauthn-validate.js';

const ok = (over: Partial<Parameters<typeof assertWebAuthnConfig>[0]> = {}) =>
  assertWebAuthnConfig({ rpID: 'example.com', rpName: 'Pipeline Builder', origins: ['https://example.com'], ...over });

describe('resolveWebAuthnConfig', () => {
  it('derives the RP ID from the frontend hostname and keeps the port in the origin', () => {
    const cfg = resolveWebAuthnConfig({}, 'https://localhost:8443');
    expect(cfg).toEqual({ rpID: 'localhost', rpName: 'Pipeline Builder', origins: ['https://localhost:8443'] });
  });

  it('uses the exact hostname, never the parent domain', () => {
    // A parent-domain RP ID would let every sibling subdomain assert the credential.
    expect(resolveWebAuthnConfig({}, 'https://app.pipeline.example.com').rpID).toBe('app.pipeline.example.com');
  });

  it('honors the WEBAUTHN_* overrides, including a comma-separated origin list', () => {
    const cfg = resolveWebAuthnConfig(
      { WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://example.com, https://app.example.com', WEBAUTHN_RP_NAME: 'Acme' },
      'https://ignored.example.org',
    );
    expect(cfg).toEqual({ rpID: 'example.com', rpName: 'Acme', origins: ['https://example.com', 'https://app.example.com'] });
  });
});

describe('assertWebAuthnConfig', () => {
  it('accepts the derived defaults for every shipped target', () => {
    for (const url of ['https://localhost:8443', 'http://localhost:3000', 'https://pipelines.example.com']) {
      expect(() => assertWebAuthnConfig(resolveWebAuthnConfig({}, url))).not.toThrow();
    }
  });

  it('accepts a subdomain origin under the RP ID', () => {
    expect(() => ok({ origins: ['https://app.example.com'] })).not.toThrow();
  });

  it('rejects an IP-address RP ID (browsers refuse it outright)', () => {
    expect(() => ok({ rpID: '10.0.0.5', origins: ['https://10.0.0.5'] })).toThrow(/IP address/);
  });

  it('rejects an RP ID that is a URL rather than a bare hostname', () => {
    expect(() => ok({ rpID: 'https://example.com' })).toThrow(/bare hostname/);
  });

  it('rejects an origin outside the RP ID', () => {
    expect(() => ok({ origins: ['https://evil.test'] })).toThrow(/not the RP ID/);
    // A suffix match that is NOT a subdomain boundary must not slip through.
    expect(() => ok({ origins: ['https://notexample.com'] })).toThrow(/not the RP ID/);
  });

  it('rejects a plain-http origin, except localhost', () => {
    expect(() => ok({ rpID: 'localhost', origins: ['http://localhost:3000'] })).not.toThrow();
    expect(() => ok({ origins: ['http://example.com'] })).toThrow(/must be https/);
  });

  it('rejects an unusable frontend URL rather than booting with an empty RP ID', () => {
    expect(() => assertWebAuthnConfig(resolveWebAuthnConfig({}, 'not-a-url'))).toThrow(/RP ID is empty/);
  });

  it('names the env vars and the permanence of the RP ID in the failure', () => {
    expect(() => ok({ origins: [] })).toThrow(/PLATFORM_FRONTEND_URL[\s\S]*invalidates every passkey/);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Issuer/audience pinning: optional outside production, REQUIRED in it.
 *
 * Before this, `iss`/`aud` were stamped and checked only when JWT_ISSUER /
 * JWT_AUDIENCE happened to be set — and no deploy target set them, so every
 * production token was unpinned. Now a production process without them refuses
 * to sign or verify (and `assertJwtIssuerAudienceConfigured` lets it refuse to
 * boot), and the pinned path round-trips and rejects a mismatched token.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import {
  JwtIssuerAudienceConfigError,
  assertJwtIssuerAudienceConfigured,
  issuerAudienceOptions,
  verifyBearerToken,
} from '../src/middleware/jwt-verify.js';
import { signServiceToken } from '../src/middleware/service-tokens.js';
import { ServiceKeyError, signServiceJwt, verifyServiceJwt } from '../src/services/service-keys.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import { decodeJwtHeader } from '../src/utils/jwk.js';

const saved = { NODE_ENV: process.env.NODE_ENV, JWT_ISSUER: process.env.JWT_ISSUER, JWT_AUDIENCE: process.env.JWT_AUDIENCE };

function restore(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let keys: TestServiceKeysHandle;

beforeAll(() => {
  keys = installTestServiceKeys(['quota', 'billing']);
  keys.becomeService('quota');
});

afterAll(() => {
  keys.uninstall();
  restore();
});

afterEach(restore);

describe('issuerAudienceOptions', () => {
  it('is optional outside production', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    expect(issuerAudienceOptions()).toEqual({});
    expect(() => assertJwtIssuerAudienceConfigured()).not.toThrow();
  });

  it('passes both through when set', () => {
    process.env.JWT_ISSUER = 'pipeline-builder-platform';
    process.env.JWT_AUDIENCE = 'pipeline-builder';
    expect(issuerAudienceOptions()).toEqual({ issuer: 'pipeline-builder-platform', audience: 'pipeline-builder' });
  });

  it.each([
    [undefined, undefined, 'JWT_ISSUER and JWT_AUDIENCE'],
    ['pipeline-builder-platform', undefined, 'JWT_AUDIENCE'],
    [undefined, 'pipeline-builder', 'JWT_ISSUER'],
    ['', '', 'JWT_ISSUER and JWT_AUDIENCE'],
  ])('throws in production when issuer=%p audience=%p, naming what is missing', (iss, aud, named) => {
    process.env.NODE_ENV = 'production';
    if (iss === undefined) delete process.env.JWT_ISSUER; else process.env.JWT_ISSUER = iss;
    if (aud === undefined) delete process.env.JWT_AUDIENCE; else process.env.JWT_AUDIENCE = aud;
    expect(() => issuerAudienceOptions()).toThrow(JwtIssuerAudienceConfigError);
    expect(() => assertJwtIssuerAudienceConfigured()).toThrow(`${named} must be set when NODE_ENV=production`);
  });

  it('is satisfied in production when both are set', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ISSUER = 'pipeline-builder-platform';
    process.env.JWT_AUDIENCE = 'pipeline-builder';
    expect(() => assertJwtIssuerAudienceConfigured()).not.toThrow();
  });
});

describe('service tokens under pinning', () => {
  it('stamps iss/aud and verifies them end to end', async () => {
    process.env.JWT_ISSUER = 'pipeline-builder-platform';
    process.env.JWT_AUDIENCE = 'pipeline-builder';
    const token = signServiceToken({ serviceName: 'quota', role: 'member' });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.iss).toBe('pipeline-builder-platform');
    expect(decoded.aud).toBe('pipeline-builder');
    await expect(verifyBearerToken(token)).resolves.toMatchObject({ sub: 'service:quota' });
  });

  it('rejects a token minted for another audience', async () => {
    process.env.JWT_ISSUER = 'pipeline-builder-platform';
    process.env.JWT_AUDIENCE = 'someone-else';
    const token = signServiceToken({ serviceName: 'quota', role: 'member' });
    process.env.JWT_AUDIENCE = 'pipeline-builder';
    await expect(verifyBearerToken(token)).rejects.toThrow(/audience/);
  });

  it('refuses to mint in production without the pins', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    expect(() => signServiceToken({ serviceName: 'quota', role: 'member' })).toThrow(JwtIssuerAudienceConfigError);
  });

  it('fails closed on verify in production without the pins', async () => {
    const token = signServiceToken({ serviceName: 'quota', role: 'member' });
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    await expect(verifyBearerToken(token)).rejects.toThrow(JwtIssuerAudienceConfigError);
  });

  it('signServiceJwt / verifyServiceJwt refuse direct callers that omit the pins in production', () => {
    const token = signServiceToken({ serviceName: 'quota', role: 'member' });
    const kid = decodeJwtHeader(token)!.kid!;
    process.env.NODE_ENV = 'production';
    expect(() => signServiceJwt({}, { serviceName: 'quota', expiresInSeconds: 60 })).toThrow(ServiceKeyError);
    expect(() => signServiceJwt({}, { serviceName: 'quota', expiresInSeconds: 60, issuer: 'i' })).toThrow(/audience/);
    expect(() => verifyServiceJwt(token, { kid })).toThrow(/issuer and audience/);
    // With both supplied, the direct path works in production.
    const pinned = signServiceJwt({ type: 'access' }, { serviceName: 'quota', expiresInSeconds: 60, issuer: 'i', audience: 'a' });
    expect(verifyServiceJwt(pinned, { kid, issuer: 'i', audience: 'a' })).toMatchObject({ sub: 'service:quota' });
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PKCE primitives (RFC 7636, helpers/pkce.ts).
 *
 * The derivation is the part an attacker would attack, so it is checked against
 * an independently computed SHA-256 rather than against itself, including the
 * specification's own worked example.
 */

import crypto from 'crypto';
import { describe, it, expect } from '@jest/globals';
import {
  PKCE_METHOD_S256,
  codeChallengeFor,
  createCodeVerifier,
  createPkcePair,
  pkceAuthorizeParams,
} from '../src/helpers/pkce.js';

describe('createCodeVerifier', () => {
  it('produces a 43-character verifier from the RFC 7636 unreserved alphabet', () => {
    const verifier = createCodeVerifier();
    // §4.1: 43-128 characters of [A-Z] [a-z] [0-9] - . _ ~ — and no base64 padding.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(verifier).toHaveLength(43);
    expect(verifier).not.toContain('=');
  });

  it('is unpredictable — 100 verifiers, no repeats', () => {
    const seen = new Set(Array.from({ length: 100 }, () => createCodeVerifier()));
    expect(seen.size).toBe(100);
  });
});

describe('codeChallengeFor', () => {
  it('is the unpadded base64url SHA-256 of the verifier', () => {
    const verifier = createCodeVerifier();
    const expected = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(codeChallengeFor(verifier)).toBe(expected);
    expect(codeChallengeFor(verifier)).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it('matches the worked example in RFC 7636 appendix B', () => {
    expect(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is deterministic for a verifier and different for any other', () => {
    const a = createCodeVerifier();
    const b = createCodeVerifier();
    expect(codeChallengeFor(a)).toBe(codeChallengeFor(a));
    expect(codeChallengeFor(a)).not.toBe(codeChallengeFor(b));
  });
});

describe('createPkcePair / pkceAuthorizeParams', () => {
  it('pairs a verifier with its own challenge', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(codeChallengeFor(verifier));
  });

  it('sends only the challenge and the S256 method — never the verifier', () => {
    const verifier = createCodeVerifier();
    const params = pkceAuthorizeParams(verifier);
    expect(params).toEqual({ code_challenge: codeChallengeFor(verifier), code_challenge_method: PKCE_METHOD_S256 });
    expect(PKCE_METHOD_S256).toBe('S256');
    expect(Object.values(params)).not.toContain(verifier);
  });
});

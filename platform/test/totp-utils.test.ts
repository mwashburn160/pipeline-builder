// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `utils/totp` — the algorithm, pinned against the RFCs' own test vectors.
 *
 * These vectors are the whole reason writing TOTP over `crypto` instead of
 * pulling in `otplib` is defensible: RFC 4226 Appendix D and RFC 6238 Appendix B
 * publish exact expected outputs, so "our HMAC/truncation is right" is a fact
 * this file checks rather than a claim the dependency would make for us.
 *
 * The rest covers what the service depends on: base32 round-tripping (including
 * the messy forms people paste), the ±1 drift window, the `minStep` replay
 * refusal, and the `otpauth://` URI's encoding.
 */

import { describe, it, expect } from '@jest/globals';
import {
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  timeStepAt,
  totpAuthUri,
  totpCode,
  totpCodeForStep,
  verifyTotp,
} from '../src/utils/totp.js';

/** RFC 4226's shared secret, "12345678901234567890", as base32. */
const RFC4226_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [1, 2, 3, 4, 5, 7, 10, 20, 32]) {
      // `% 256` rather than a mask — the repo's no-bitwise rule, and it says the
      // same thing.
      const bytes = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) % 256));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('matches RFC 4648 vectors and emits no padding', () => {
    expect(base32Encode(Buffer.from('foobar', 'ascii'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f', 'ascii'))).toBe('MY');
  });

  it('tolerates the padding, spacing and case people paste', () => {
    const expected = base32Decode('MZXW6YTBOI');
    for (const messy of ['mzxw6ytboi', 'MZXW 6YTB OI', 'MZXW-6YTB-OI', 'MZXW6YTBOI======']) {
      expect(base32Decode(messy).equals(expected)).toBe(true);
    }
  });

  it('refuses a character outside the alphabet rather than dropping it', () => {
    // Silently skipping would yield a key that is subtly wrong — an enrolment
    // that scans cleanly and then never verifies.
    expect(() => base32Decode('MZXW6YT1')).toThrow(/Invalid base32/);
  });
});

describe('HOTP — RFC 4226 Appendix D vectors', () => {
  // Counters 0..9 against the RFC's shared secret.
  const EXPECTED = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  it.each(EXPECTED.map((code, counter) => [counter, code]))('counter %i → %s', (counter, code) => {
    expect(totpCodeForStep(RFC4226_SECRET, counter as number)).toBe(code);
  });
});

describe('TOTP — RFC 6238 Appendix B vectors (SHA-1)', () => {
  // The RFC's SHA-1 rows, truncated to the 6 digits this implementation emits
  // (the published table is 8 digits; the low 6 are the same value mod 10^6).
  const CASES: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  it.each(CASES)('t=%i → %s', (seconds, expected) => {
    expect(totpCode(RFC4226_SECRET, seconds * 1000)).toBe(expected);
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const step = timeStepAt(now);

  it('accepts the current code and reports its step', () => {
    expect(verifyTotp(secret, totpCodeForStep(secret, step), { nowMs: now })).toBe(step);
  });

  it('accepts exactly one step of drift either side', () => {
    expect(verifyTotp(secret, totpCodeForStep(secret, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 1), { nowMs: now })).toBe(step + 1);
  });

  it('refuses two steps out — a wider window is more live codes to guess', () => {
    expect(verifyTotp(secret, totpCodeForStep(secret, step - 2), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 2), { nowMs: now })).toBeNull();
  });

  it('refuses a step at or below minStep (replay)', () => {
    const code = totpCodeForStep(secret, step);
    expect(verifyTotp(secret, code, { nowMs: now, minStep: step })).toBeNull();
    // The step BEFORE the spent one is inside the drift window but still spent.
    expect(verifyTotp(secret, totpCodeForStep(secret, step - 1), { nowMs: now, minStep: step })).toBeNull();
    // ...while the NEXT step is still acceptable.
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 1), { nowMs: now, minStep: step })).toBe(step + 1);
  });

  it('refuses anything that is not six digits, without touching the secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(secret, bad, { nowMs: now })).toBeNull();
    }
  });

  it('ignores the spaces authenticator apps display codes with', () => {
    const code = totpCodeForStep(secret, step);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now })).toBe(step);
  });

  it('refuses a code minted under a different secret', () => {
    expect(verifyTotp(secret, totpCodeForStep(generateTotpSecret(), step), { nowMs: now })).toBeNull();
  });
});

describe('timeStepAt', () => {
  it('advances once per period', () => {
    // Step-aligned, so "one second short of a period" stays inside the step
    // rather than straddling a boundary.
    const base = 1_700_000_040_000;
    expect(timeStepAt(base) * TOTP_PERIOD_SECONDS * 1000).toBe(base);
    expect(timeStepAt(base + TOTP_PERIOD_SECONDS * 1000) - timeStepAt(base)).toBe(1);
    expect(timeStepAt(base + (TOTP_PERIOD_SECONDS - 1) * 1000)).toBe(timeStepAt(base));
  });
});

describe('otpauth URI', () => {
  it('carries the issuer in both the label and the parameter', () => {
    const uri = totpAuthUri({ secret: 'ABCD', account: 'a@b.example', issuer: 'Pipeline Builder' });
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    // Both forms, because apps read one or the other and reject a disagreement.
    expect(uri).toContain('Pipeline%20Builder:a%40b.example');
    expect(parsed.searchParams.get('issuer')).toBe('Pipeline Builder');
    expect(parsed.searchParams.get('secret')).toBe('ABCD');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('are grouped, unique and normalize back to one canonical form', () => {
    const codes = Array.from({ length: 50 }, generateRecoveryCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(normalizeRecoveryCode(code.toLowerCase())).toBe(code.replace('-', ''));
    }
  });

  it('hash identically however the person types them', () => {
    const code = generateRecoveryCode();
    const expected = hashRecoveryCode(code);
    expect(hashRecoveryCode(code.toLowerCase())).toBe(expected);
    expect(hashRecoveryCode(code.replace('-', ' '))).toBe(expected);
    expect(hashRecoveryCode(code.replace('-', ''))).toBe(expected);
    // ...and a different code does not collide.
    expect(hashRecoveryCode(generateRecoveryCode())).not.toBe(expected);
  });
});

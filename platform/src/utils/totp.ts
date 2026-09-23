// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), plus the base32 alphabet (RFC 4648)
 * authenticator apps expect — written against Node's `crypto` rather than taken
 * from a library.
 *
 * WHY NO DEPENDENCY: the whole algorithm is one HMAC, a dynamic truncation and a
 * modulo; base32 is a 5-bit bit-packer. `otplib` (the obvious candidate) is six
 * packages plus `@noble/hashes` and `@scure/base` for exactly this, and every
 * one of them would sit inside the platform's authentication path. The repo's
 * standing rule is to reach for `crypto` when `crypto` suffices, and here it
 * does — with the RFC 4226 Appendix D test vectors pinning correctness.
 *
 * PARAMETERS are fixed at SHA-1 / 6 digits / 30 seconds. Not because they are
 * the strongest choice, but because they are the ONLY combination every
 * authenticator (Google Authenticator, iOS Passwords, 1Password, Authy, Aegis)
 * reads reliably from an `otpauth://` URI — several silently ignore `algorithm`
 * and `digits`, which produces an enrolment that scans cleanly and then never
 * verifies. The HMAC key is 160 random bits, so SHA-1's collision weakness is
 * irrelevant here: HMAC-SHA1's security rests on PRF strength, not collision
 * resistance, and a 6-digit code is the actual bound.
 *
 * Nothing in this module touches storage, time-step reuse or rate limits —
 * `services/totp-service.ts` owns all of that. This file is pure and
 * deterministic, which is what makes it testable against the RFC vectors.
 */

/* eslint-disable no-bitwise -- This file IS bit manipulation: base32 is a 5-bit
 * packer and RFC 4226's dynamic truncation is defined in terms of masks and
 * shifts. The repo bans bitwise operators because they are usually an obscure
 * way to write arithmetic; here they are the specification, and rewriting
 * `(digest[offset] & 0x7f) << 24` as multiplication would make the code harder
 * to check against the RFC rather than easier. Scoped to this module, which does
 * nothing else. */

import crypto from 'crypto';

/** Seconds per time step (RFC 6238 default; what every authenticator assumes). */
export const TOTP_PERIOD_SECONDS = 30;

/** Digits in a code. Six — see the module doc on interoperability. */
const TOTP_DIGITS = 6;

/** HMAC hash. SHA-1 for the same interoperability reason. */
const TOTP_ALGORITHM = 'sha1';

/** Secret size in bytes. 160 bits — the RFC 4226 recommendation and the natural
 *  key length for HMAC-SHA1 (larger keys are hashed down, so they buy nothing). */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode bytes as unpadded RFC 4648 base32.
 *
 * Unpadded on purpose: the `secret=` parameter of an `otpauth://` URI is
 * base32 without `=`, and several authenticators reject a padded one.
 */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode base32 back to bytes. Case-insensitive, and tolerant of the padding and
 * grouping spaces people paste when they type a secret in by hand.
 *
 * Throws on any character outside the alphabet — a silently-dropped character
 * would produce a key that is subtly wrong, i.e. an enrolment that never
 * verifies with no explanation.
 */
export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32-encoded for the `otpauth://` URI. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** The time step a moment falls in. Exported so the service can record which
 *  step a code consumed (replay protection). */
export function timeStepAt(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * HOTP (RFC 4226 §5.3): HMAC the 8-byte big-endian counter, take the low nibble
 * of the last byte as an offset, read 31 bits from there, and reduce mod 10^d.
 */
function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // `writeBigUInt64BE` rather than two 32-bit halves: the counter is a time step,
  // so it stays well inside Number.MAX_SAFE_INTEGER, but the BigInt conversion
  // makes that explicit instead of relying on it.
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(TOTP_ALGORITHM, key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/** The code a base32 secret produces for one time step. */
export function totpCodeForStep(secretBase32: string, step: number): string {
  return hotp(base32Decode(secretBase32), step);
}

/**
 * Drift allowance, in steps either side of the current one. ONE — so a code is
 * accepted for at most 90 seconds. Wider windows are the usual way TOTP gets
 * weakened: every extra step is another live code an attacker may guess, and
 * clock skew beyond 30 seconds is a broken device clock, not something to
 * paper over.
 */
export const TOTP_DRIFT_STEPS = 1;

/**
 * Verify `code` against `secretBase32`, returning the time step it matched (so
 * the caller can refuse to accept that step again) or `null`.
 *
 * `minStep`, when given, refuses anything at or below a step the account has
 * already spent — replay protection lives in the service, but the comparison
 * belongs next to the step arithmetic.
 *
 * The digit comparison is constant-time. A 6-digit space is small enough that
 * timing leakage is not the realistic attack (rate limits are), but a
 * short-circuiting `===` on a secret-derived value is the kind of thing that
 * gets copied into somewhere it does matter.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { nowMs?: number; minStep?: number; driftSteps?: number } = {},
): number | null {
  const normalized = code.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return null;

  const drift = opts.driftSteps ?? TOTP_DRIFT_STEPS;
  const current = timeStepAt(opts.nowMs ?? Date.now());
  const key = base32Decode(secretBase32);
  const candidate = Buffer.from(normalized, 'utf8');

  let matched: number | null = null;
  for (let offset = -drift; offset <= drift; offset++) {
    const step = current + offset;
    if (opts.minStep !== undefined && step <= opts.minStep) continue;
    const expected = Buffer.from(hotp(key, step), 'utf8');
    // No early `break`: keep the loop's work independent of WHERE the match is.
    if (expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate)) {
      matched = step;
    }
  }
  return matched;
}

/**
 * The `otpauth://totp/…` URI an authenticator scans.
 *
 * `issuer` appears BOTH in the label prefix and as a parameter: the parameter is
 * the modern form, the prefix is what older apps read, and apps that understand
 * both require them to agree. Every component is percent-encoded — an account
 * name is an email address, and an issuer is operator-configured text.
 */
export function totpAuthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: TOTP_ALGORITHM.toUpperCase(),
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** How many recovery codes an enrolment (or a regeneration) mints. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * A recovery code: 10 base32 characters, shown grouped as `XXXXX-XXXXX`.
 *
 * ~50 bits of entropy, which is far more than the 6-digit codes it stands in
 * for; the grouping is purely so a person can read one off a printout without
 * losing their place. Base32's alphabet has no 0/O or 1/I to confuse.
 */
export function generateRecoveryCode(): string {
  // 7 bytes = 56 bits → 12 base32 chars; take 10 (50 bits) for a readable code.
  const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Strip the presentation grouping so a typed code matches a stored hash. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Hash a recovery code for storage.
 *
 * SHA-256, not bcrypt: a recovery code is 50 bits of uniform randomness that
 * nobody chose and nobody reuses, so there is no dictionary to slow down — the
 * only thing a work factor would buy is CPU on a sign-in path an attacker can
 * reach. (A password hash is a different problem and keeps bcrypt.)
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

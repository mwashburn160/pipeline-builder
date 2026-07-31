// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discount coupon codec — the foundation of the billing-discounts feature.
 *
 * Two distinct string forms live here, deliberately kept apart:
 *
 *  1. The AUTHORING form — `value:unit:kind[:campaign]` — is what a system
 *     admin types when minting a discount (e.g. `50:percent:onetime` or
 *     `25:dollar:recurring:summer24`). It is human-readable and self-describing.
 *     `parseAuthoringForm` validates + normalizes it (aliases `$`/`%`, whole
 *     dollars → cents) into a {@link DiscountSpec}.
 *
 *  2. The ISSUED TOKEN — an opaque, non-deterministic AES-256-GCM string — is
 *     what a customer receives (Mode B) and pastes back to redeem. It carries a
 *     {@link DiscountTokenPayload} (the discount id + its parsed fields) and is
 *     unforgeable: only a holder of the signing key can mint one that decodes,
 *     so a well-formed token is not the same as an authorized one but a forged
 *     one is rejected outright. `encodeDiscountCode`/`decodeDiscountCode` are
 *     the round trip.
 *
 * Base64 alone was rejected for the token: it is reversible AND forgeable
 * (anyone could re-encode their own `100:percent:recurring`). GCM authentication
 * is what makes the token tamper-evident; the random 12-byte IV per mint is what
 * makes it non-deterministic (re-issuing the same discount yields a fresh
 * string, all decoding to the same id). At coupon volumes the 96-bit random-IV
 * birthday bound is never approached, so a single active key is safe.
 *
 * This module has NO api-core / model dependency on purpose — it is a pure
 * codec, unit-testable without mocks.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ─── Domain vocabulary ──────────────────────────────────────────────

export const DISCOUNT_UNITS = ['dollar', 'percent'] as const;
export type DiscountUnit = (typeof DISCOUNT_UNITS)[number];

export const DISCOUNT_KINDS = ['onetime', 'recurring', 'credit'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/**
 * A parsed authoring form. `value` is CENTS when `unit === 'dollar'` and
 * percent-points (1-100) when `unit === 'percent'` — the same representation the
 * `Discount` record and `priceBreakdown` use, so no unit juggling downstream.
 */
export interface DiscountSpec {
  value: number;
  unit: DiscountUnit;
  kind: DiscountKind;
  campaign?: string;
}

/** The plaintext sealed inside an issued token. `id` is the opaque `Discount._id`. */
export interface DiscountTokenPayload {
  id: string;
  value: number;
  unit: DiscountUnit;
  kind: DiscountKind;
  targetOrgId?: string;
}

/** Typed-error return convention (mirrors api-core's `parseDateRange`). */
export type ParseResult<T> = T | { error: string };

// Hard sanity bounds enforced by the PARSER (format-level). The real business
// limit is the mint-time config ceiling (BILLING_DISCOUNT_MAX_*), applied later
// in the generation flow — this only rejects nonsensical input up front.
const MAX_SANE_DOLLARS = 1_000_000; // → 100_000_000 cents
const CAMPAIGN_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ─── Authoring form ─────────────────────────────────────────────────

/** Normalize a raw unit token, honoring the `$` / `%` aliases. */
function normalizeUnit(raw: string): DiscountUnit | undefined {
  const u = raw.trim().toLowerCase();
  if (u === 'dollar' || u === '$') return 'dollar';
  if (u === 'percent' || u === '%') return 'percent';
  return undefined;
}

/**
 * Parse + validate the authoring form `value:unit:kind[:campaign]`.
 *
 * Returns a {@link DiscountSpec} with `value` normalized to cents (dollar) or
 * percent-points (percent), or `{ error }` on any format violation. Rejects:
 * wrong field count, non-integer / zero / negative value, percent outside 1-100,
 * dollars beyond the sanity cap, unknown unit/kind, and a malformed campaign.
 */
export function parseAuthoringForm(input: string): ParseResult<DiscountSpec> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { error: 'discount code is required' };
  }
  const parts = input.trim().split(':');
  if (parts.length < 3 || parts.length > 4) {
    return { error: 'discount code must be "value:unit:kind[:campaign]"' };
  }
  const [rawValue, rawUnit, rawKind, rawCampaign] = parts;

  // value — strictly a positive integer (no decimals, no signs, no exponents).
  if (!/^\d+$/.test(rawValue.trim())) {
    return { error: 'value must be a positive whole number' };
  }
  const rawNum = Number(rawValue.trim());
  if (!Number.isSafeInteger(rawNum) || rawNum <= 0) {
    return { error: 'value must be a positive whole number' };
  }

  const unit = normalizeUnit(rawUnit);
  if (!unit) return { error: 'unit must be one of: dollar ($), percent (%)' };

  const kind = rawKind.trim().toLowerCase() as DiscountKind;
  if (!DISCOUNT_KINDS.includes(kind)) {
    return { error: `kind must be one of: ${DISCOUNT_KINDS.join(', ')}` };
  }

  let value: number;
  if (unit === 'percent') {
    if (rawNum > 100) return { error: 'percent value must be between 1 and 100' };
    value = rawNum; // percent points
  } else {
    if (rawNum > MAX_SANE_DOLLARS) return { error: 'dollar value is unreasonably large' };
    value = rawNum * 100; // whole dollars → cents
  }

  let campaign: string | undefined;
  if (rawCampaign !== undefined) {
    campaign = rawCampaign.trim();
    if (!CAMPAIGN_RE.test(campaign)) {
      return { error: 'campaign may contain only letters, digits, "-" and "_" (max 64)' };
    }
  }

  return campaign ? { value, unit, kind, campaign } : { value, unit, kind };
}

// ─── Key ring (versioned AES-256-GCM keys) ──────────────────────────

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION_RE = /^v(\d+)$/;

interface KeyRing {
  keys: Map<string, Buffer>;
  active: { version: string; key: Buffer };
}

/**
 * Parse `BILLING_DISCOUNT_KEYS` (`v1:<base64-32B>,v2:<base64-32B>`) into a key
 * ring. The ACTIVE mint key is the highest version number (order-independent),
 * so rotation is "add a higher-numbered key"; older keys stay for decode-only.
 * Throws on a missing/empty ring, a malformed entry, or any key that is not
 * exactly 32 bytes — a misconfigured signing key must fail fast at boot, never
 * silently mint undecodable tokens.
 */
export function loadKeyRing(raw: string | undefined = process.env.BILLING_DISCOUNT_KEYS): KeyRing {
  if (!raw || raw.trim().length === 0) {
    throw new Error('BILLING_DISCOUNT_KEYS is not configured');
  }
  const keys = new Map<string, Buffer>();
  let activeNum = -1;
  let active: KeyRing['active'] | undefined;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) throw new Error('BILLING_DISCOUNT_KEYS entry must be "v<n>:<base64key>"');
    const version = trimmed.slice(0, sep).trim();
    const m = VERSION_RE.exec(version);
    if (!m) throw new Error(`BILLING_DISCOUNT_KEYS has an invalid version "${version}"`);
    const key = Buffer.from(trimmed.slice(sep + 1).trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`BILLING_DISCOUNT_KEYS key "${version}" must decode to ${KEY_BYTES} bytes`);
    }
    keys.set(version, key);
    const num = Number(m[1]);
    if (num > activeNum) { activeNum = num; active = { version, key }; }
  }
  if (!active) throw new Error('BILLING_DISCOUNT_KEYS contained no usable keys');
  return { keys, active };
}

// ─── Token codec ────────────────────────────────────────────────────

function isValidPayload(p: unknown): p is DiscountTokenPayload {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.id === 'string' && o.id.length > 0 &&
    typeof o.value === 'number' && Number.isFinite(o.value) &&
    typeof o.unit === 'string' && (DISCOUNT_UNITS as readonly string[]).includes(o.unit) &&
    typeof o.kind === 'string' && (DISCOUNT_KINDS as readonly string[]).includes(o.kind) &&
    (o.targetOrgId === undefined || typeof o.targetOrgId === 'string')
  );
}

/**
 * Seal a payload into an opaque, non-deterministic token
 * `"<version>.<base64url(iv|ciphertext|tag)>"`. Uses the active (highest) key
 * and a fresh random IV per call, so two mints of the same discount produce
 * different strings that both decode to the same payload.
 */
export function encodeDiscountCode(
  payload: DiscountTokenPayload,
  ring: KeyRing = loadKeyRing(),
): string {
  const { version, key } = ring.active;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([iv, ciphertext, tag]).toString('base64url');
  return `${version}.${body}`;
}

/**
 * Verify + open a token. Returns the {@link DiscountTokenPayload}, or `{ error }`
 * for a malformed string, an unknown key version, a failed GCM tag (forged /
 * tampered), or a structurally invalid payload. Never throws on bad input — a
 * hostile paste is a validation outcome, not an exception.
 */
export function decodeDiscountCode(
  token: string,
  ring: KeyRing = loadKeyRing(),
): ParseResult<DiscountTokenPayload> {
  if (typeof token !== 'string' || token.length === 0) {
    return { error: 'discount code is required' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0) return { error: 'malformed discount code' };
  const version = token.slice(0, dot);
  const key = ring.keys.get(version);
  if (!key) return { error: 'unknown discount code key version' };

  const buf = Buffer.from(token.slice(dot + 1), 'base64url');
  if (buf.length < IV_BYTES + TAG_BYTES + 1) return { error: 'malformed discount code' };
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return { error: 'invalid or tampered discount code' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return { error: 'invalid or tampered discount code' };
  }
  if (!isValidPayload(parsed)) return { error: 'invalid discount code payload' };
  return parsed;
}

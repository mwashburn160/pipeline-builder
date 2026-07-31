// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the discount coupon codec (Phase 1). Pure module — no mocks.
 * Covers the authoring-form parser, the versioned AES-256-GCM key ring, and the
 * token encode/decode round trip incl. non-determinism, forgery/tamper
 * rejection, and key rotation.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  parseAuthoringForm,
  loadKeyRing,
  encodeDiscountCode,
  decodeDiscountCode,
  DISCOUNT_KINDS,
  type DiscountTokenPayload,
} from '../src/helpers/discount-code.js';

// Deterministic 32-byte keys for the tests.
const KEY_V1 = Buffer.alloc(32, 7).toString('base64');
const KEY_V2 = Buffer.alloc(32, 9).toString('base64');
const RING_V1 = loadKeyRing(`v1:${KEY_V1}`);
const RING_V1_V2 = loadKeyRing(`v1:${KEY_V1},v2:${KEY_V2}`);

describe('parseAuthoringForm', () => {
  it('parses percent codes (value stays percent-points)', () => {
    expect(parseAuthoringForm('50:percent:onetime')).toEqual({ value: 50, unit: 'percent', kind: 'onetime' });
  });

  it('parses dollar codes (whole dollars → cents)', () => {
    expect(parseAuthoringForm('25:dollar:recurring')).toEqual({ value: 2500, unit: 'dollar', kind: 'recurring' });
  });

  it('honors the $ and % aliases', () => {
    expect(parseAuthoringForm('10:$:credit')).toEqual({ value: 1000, unit: 'dollar', kind: 'credit' });
    expect(parseAuthoringForm('10:%:onetime')).toEqual({ value: 10, unit: 'percent', kind: 'onetime' });
  });

  it('normalizes case in unit and kind', () => {
    expect(parseAuthoringForm('5:PERCENT:CREDIT')).toEqual({ value: 5, unit: 'percent', kind: 'credit' });
  });

  it('captures an optional campaign label', () => {
    expect(parseAuthoringForm('50:percent:onetime:summer24')).toEqual({
      value: 50, unit: 'percent', kind: 'onetime', campaign: 'summer24',
    });
  });

  it('recognizes every kind', () => {
    for (const kind of DISCOUNT_KINDS) {
      expect(parseAuthoringForm(`5:percent:${kind}`)).toMatchObject({ kind });
    }
  });

  it.each([
    ['empty', ''],
    ['too few fields', '50:percent'],
    ['too many fields', '50:percent:onetime:camp:extra'],
    ['zero value', '0:percent:onetime'],
    ['negative value', '-5:percent:onetime'],
    ['decimal value', '5.5:dollar:onetime'],
    ['non-numeric value', 'abc:dollar:onetime'],
    ['percent over 100', '101:percent:onetime'],
    ['unknown unit', '50:euros:onetime'],
    ['unknown kind', '50:percent:forever'],
    ['bad campaign charset', '50:percent:onetime:bad campaign!'],
    ['dollars overflow', '2000000:dollar:onetime'],
  ])('rejects %s', (_label, input) => {
    const result = parseAuthoringForm(input);
    expect(result).toHaveProperty('error');
  });
});

describe('loadKeyRing', () => {
  it('selects the highest version as the active mint key (order-independent)', () => {
    expect(loadKeyRing(`v2:${KEY_V2},v1:${KEY_V1}`).active.version).toBe('v2');
    expect(loadKeyRing(`v1:${KEY_V1},v2:${KEY_V2}`).active.version).toBe('v2');
  });

  it.each([
    ['empty', ''],
    ['undefined', undefined],
    ['missing version prefix', `${KEY_V1}`],
    ['bad version token', `x1:${KEY_V1}`],
    ['short key', 'v1:' + Buffer.alloc(16, 1).toString('base64')],
  ])('throws on %s config', (_label, raw) => {
    expect(() => loadKeyRing(raw as string | undefined)).toThrow();
  });
});

describe('encode/decode round trip', () => {
  const payload: DiscountTokenPayload = { id: 'disc_abc', value: 50, unit: 'percent', kind: 'onetime' };

  it('round-trips a payload', () => {
    const token = encodeDiscountCode(payload, RING_V1);
    expect(decodeDiscountCode(token, RING_V1)).toEqual(payload);
  });

  it('round-trips a targeted payload', () => {
    const targeted: DiscountTokenPayload = { ...payload, kind: 'credit', unit: 'dollar', value: 10000, targetOrgId: 'org_root_1' };
    const token = encodeDiscountCode(targeted, RING_V1);
    expect(decodeDiscountCode(token, RING_V1)).toEqual(targeted);
  });

  it('is non-deterministic — two mints differ but decode to the same payload', () => {
    const t1 = encodeDiscountCode(payload, RING_V1);
    const t2 = encodeDiscountCode(payload, RING_V1);
    expect(t1).not.toBe(t2);
    expect(decodeDiscountCode(t1, RING_V1)).toEqual(payload);
    expect(decodeDiscountCode(t2, RING_V1)).toEqual(payload);
  });
});

describe('decodeDiscountCode — rejection paths', () => {
  const token = encodeDiscountCode({ id: 'disc_abc', value: 50, unit: 'percent', kind: 'onetime' }, RING_V1);

  it('rejects a tampered body (failed GCM tag)', () => {
    // Flip the final base64url char of the body to corrupt the auth tag.
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(decodeDiscountCode(flipped, RING_V1)).toHaveProperty('error');
  });

  it.each([
    ['empty', ''],
    ['no version separator', 'v1'],
    ['too-short body', 'v1.AAAA'],
    ['garbage', 'not-a-token'],
  ])('rejects %s', (_label, bad) => {
    expect(decodeDiscountCode(bad, RING_V1)).toHaveProperty('error');
  });

  it('rejects an unknown key version', () => {
    expect(decodeDiscountCode('v9.AAAAAAAAAAAAAAAAAAAAAAAA', RING_V1)).toEqual({ error: 'unknown discount code key version' });
  });
});

describe('key rotation', () => {
  const payload: DiscountTokenPayload = { id: 'disc_rot', value: 25, unit: 'dollar', kind: 'recurring' };

  it('mints under the newest key but still decodes older tokens', () => {
    const oldToken = encodeDiscountCode(payload, RING_V1); // minted under v1
    const newToken = encodeDiscountCode(payload, RING_V1_V2); // minted under v2 (highest)
    expect(oldToken.startsWith('v1.')).toBe(true);
    expect(newToken.startsWith('v2.')).toBe(true);
    // A ring holding both keys decodes both.
    expect(decodeDiscountCode(oldToken, RING_V1_V2)).toEqual(payload);
    expect(decodeDiscountCode(newToken, RING_V1_V2)).toEqual(payload);
    // A ring that has only v1 cannot decode a v2 token (key retired = kill switch).
    expect(decodeDiscountCode(newToken, RING_V1)).toEqual({ error: 'unknown discount code key version' });
  });
});

describe('env-default key ring', () => {
  afterEach(() => { delete process.env.BILLING_DISCOUNT_KEYS; });

  it('reads BILLING_DISCOUNT_KEYS when no ring is passed', () => {
    process.env.BILLING_DISCOUNT_KEYS = `v1:${KEY_V1}`;
    const payload: DiscountTokenPayload = { id: 'disc_env', value: 5, unit: 'percent', kind: 'credit' };
    const token = encodeDiscountCode(payload);
    expect(decodeDiscountCode(token)).toEqual(payload);
  });

  it('throws from encode when unconfigured', () => {
    expect(() => encodeDiscountCode({ id: 'x', value: 1, unit: 'percent', kind: 'onetime' })).toThrow(/BILLING_DISCOUNT_KEYS/);
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { compactJws, encodeJwsSigningInput } from '../src/utils/jwk.js';

describe('encodeJwsSigningInput / compactJws', () => {
  it('builds an ES256 header + body signing input and a compact token', () => {
    const input = encodeJwsSigningInput('kid-1', { sub: 'x' });
    const [h, b] = input.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'kid-1' });
    expect(JSON.parse(Buffer.from(b!, 'base64url').toString())).toEqual({ sub: 'x' });
    expect(compactJws(input, Buffer.from([1, 2, 3]))).toBe(`${input}.AQID`);
  });
});

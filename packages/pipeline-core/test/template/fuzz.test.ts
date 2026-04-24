// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { tokenize, TokenizerError } from '../../src/template/tokenizer';
import { resolve } from '../../src/template/evaluator';

/**
 * Property-style fuzz tests for the template engine. The goal is not exhaustive
 * coverage but to assert the engine never blows up on arbitrary input: every
 * string either tokenizes cleanly or throws a well-typed `TokenizerError`.
 *
 * Uses a deterministic PRNG so failures are reproducible.
 */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARSET = [
  'a', 'b', 'c', 'x', 'y', 'z', '.', '_', '1', '2', '3', ' ', '\t',
  '{', '}', '|', ':', "'", '"', '\\', '-', '\n',
];
function randomString(rand: () => number, maxLen = 60): string {
  const len = Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CHARSET[Math.floor(rand() * CHARSET.length)]!;
  }
  return s;
}

describe('fuzz: tokenizer never crashes unexpectedly', () => {
  const rand = mulberry32(0xDEADBEEF);
  for (let i = 0; i < 200; i++) {
    const input = randomString(rand, 80);
    it(`sample #${i} (${JSON.stringify(input).slice(0, 50)})`, () => {
      let out: unknown;
      let thrown: unknown;
      try {
        out = tokenize(input);
      } catch (err) {
        thrown = err;
      }
      if (thrown) {
        // Every thrown error must be a TokenizerError with a position
        expect(thrown).toBeInstanceOf(TokenizerError);
        expect((thrown as TokenizerError).pos).toBeDefined();
      } else {
        expect(Array.isArray(out)).toBe(true);
      }
    });
  }
});

describe('fuzz: resolved tokens round-trip against a scope', () => {
  const rand = mulberry32(0xC0FFEE);
  const scope = {
    pipeline: { metadata: { env: 'prod', region: 'us-east-1' } },
    plugin: { name: 'test', version: '1.0' },
    env: { HOME: '/root' },
  };
  for (let i = 0; i < 50; i++) {
    const input = `prefix-${randomString(rand, 20)}-{{ pipeline.metadata.env | default: 'd' }}-suffix`;
    it(`resolves #${i}`, () => {
      try {
        const toks = tokenize(input);
        const out = resolve(toks, scope);
        // Post-condition: resolved output is a string (no coercion in this
        // fuzz path) and contains no '{{' template markers
        expect(typeof out).toBe('string');
        expect((out as string).includes('{{')).toBe(false);
      } catch (err) {
        // Acceptable failure: parser error on malformed template content
        expect(err).toBeInstanceOf(TokenizerError);
      }
    });
  }
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { redactSensitive } from '../src/utils/logger.js';

describe('redactSensitive', () => {
  it('masks top-level sensitive keys', () => {
    expect(redactSensitive({ password: 'p', token: 't', user: 'alice' })).toEqual({
      password: '[REDACTED]',
      token: '[REDACTED]',
      user: 'alice',
    });
  });

  it('walks nested objects and arrays', () => {
    expect(redactSensitive({ outer: { apiKey: 'secret', keep: 1 }, list: [{ secret: 'x' }] })).toEqual({
      outer: { apiKey: '[REDACTED]', keep: 1 },
      list: [{ secret: '[REDACTED]' }],
    });
  });

  it('passes primitives through unchanged', () => {
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
  });
});

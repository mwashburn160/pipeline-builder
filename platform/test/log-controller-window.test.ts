// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** `resolveWindow` — the Logs API time-window parser. */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/observability/loki-client.js', () => ({}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAuth: jest.fn(),
  withController: (_l: string, fn: unknown) => fn,
}));

const { resolveWindow } = await import('../src/observability/log-controller.js');

describe('resolveWindow', () => {
  it('accepts a preset range', () => {
    const w = resolveWindow({ range: '1h' });
    expect('error' in w).toBe(false);
  });

  it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
    'rejects inherited Object.prototype name %p as an invalid range (not a NaN window)', (range) => {
      expect(resolveWindow({ range })).toEqual({ error: expect.stringMatching(/^Invalid range/) });
    },
  );
});

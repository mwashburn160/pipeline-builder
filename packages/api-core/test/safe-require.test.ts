// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { safeCreateRequire } from '../src/utils/safe-require.js';

describe('safeCreateRequire', () => {
  it('returns a working require for a real module url', () => {
    const req = safeCreateRequire(import.meta.url);
    expect(typeof req).toBe('function');
    expect(req('node:path')).toBeDefined();
  });

  it('does NOT throw when metaUrl is undefined (the CJS-bundle case) and still resolves', () => {
    // The bug this guards: createRequire(undefined) throws at module load.
    let req: NodeRequire | undefined;
    expect(() => { req = safeCreateRequire(undefined); }).not.toThrow();
    expect(req!('node:path')).toBeDefined();
  });

  it('does not throw on an empty string either', () => {
    expect(() => safeCreateRequire('')).not.toThrow();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { attachmentDisposition, safeFileName } from '../src/helpers/content-disposition.js';

describe('attachment file names', () => {
  it('keeps a plain plugin file name as is', () => {
    expect(attachmentDisposition('lint-1.2.0.spdx.json')).toBe('attachment; filename="lint-1.2.0.spdx.json"');
  });

  it('never lets a quote, CR/LF or path separator reach the header', () => {
    const value = attachmentDisposition('evil"\r\nSet-Cookie: x=1/../a.json');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toBe('attachment; filename="evil___Set-Cookie__x_1_.._a.json"');
    expect(safeFileName('..hidden')).toBe('_hidden');
    expect(safeFileName('')).toBe('download');
    expect(safeFileName('a'.repeat(500))).toHaveLength(200);
  });
});

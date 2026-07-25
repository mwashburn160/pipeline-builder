// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the high-level resolveTemplates() in src/template/index.ts,
 * covering two correctness bugs:
 *   1. `{{{{` escape must materialize even for literal-only fields.
 *   2. Writes must not be silently dropped for doc keys containing `.`/`[`/`]`.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from '../helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { resolveTemplates } = await import('../../src/template/index.js');

describe('resolveTemplates — {{{{ escape round-trip', () => {
  it('unescapes {{{{ to {{ for a literal-only field', () => {
    const doc = { commands: ['echo {{{{value'] };
    const res = resolveTemplates(doc, {}, () => true);
    expect(res.errors).toEqual([]);
    // `{{{{value` → `{{value` (doubled braces collapsed, no expr present).
    expect(doc.commands[0]).toBe('echo {{value');
  });

  it('unescapes {{{{ alongside a real expression in the same field', () => {
    // `{{{{` escapes to a literal `{{`; the following `{{ x }}` is a real expr.
    const doc = { commands: ['echo {{{{braces {{ x }}'] };
    const scope = { x: 'X' };
    const res = resolveTemplates(doc, scope, () => true);
    expect(res.errors).toEqual([]);
    expect(doc.commands[0]).toBe('echo {{braces X');
  });

  it('leaves a plain literal-only field with no braces untouched', () => {
    const doc = { commands: ['plain literal'] };
    const res = resolveTemplates(doc, {}, () => true);
    expect(res.errors).toEqual([]);
    expect(doc.commands[0]).toBe('plain literal');
  });
});

describe('resolveTemplates — keys with . / [ / ]', () => {
  it('writes the resolved value into a dotted/bracketed key (no silent drop)', () => {
    const doc = { env: { 'FOO.BAR[0]': '{{ x }}' } };
    const scope = { x: 'hello' };
    const res = resolveTemplates(doc, scope, () => true);
    expect(res.errors).toEqual([]);
    expect(doc.env['FOO.BAR[0]']).toBe('hello');
  });
});

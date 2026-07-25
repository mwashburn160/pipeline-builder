// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { walkAndBind } from '../../src/template/walker.js';

describe('walkAndBind', () => {
  const isTemplatable = (f: string) =>
    f.startsWith('commands') || f.startsWith('env.') || f.startsWith('description');

  it('finds templated strings in arrays', () => {
    const doc = { commands: ['echo {{ x }}', 'plain', 'then {{ y }}'] };
    const entries = walkAndBind(doc, isTemplatable);
    expect(entries.map(e => e.field)).toEqual(['commands[0]', 'commands[2]']);
  });

  it('finds templated strings in nested env objects', () => {
    const doc = { env: { STAGE: '{{ pipeline.metadata.env }}' } };
    const entries = walkAndBind(doc, isTemplatable);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.field).toBe('env.STAGE');
  });

  it('skips non-templatable fields', () => {
    const doc = { name: '{{ x }}', commands: ['{{ y }}'] };
    const entries = walkAndBind(doc, isTemplatable);
    expect(entries.map(e => e.field)).toEqual(['commands[0]']);
  });

  it('skips fields with no template tokens', () => {
    const doc = { commands: ['literal', 'also literal'] };
    const entries = walkAndBind(doc, isTemplatable);
    expect(entries).toHaveLength(0);
  });

  it('set() mutates the original root object', () => {
    const doc = { commands: ['echo {{ x }}'], env: { K: '{{ y }}' } };
    const entries = walkAndBind(doc, isTemplatable);
    for (const e of entries) {
      if (e.field === 'commands[0]') e.set('echo hello');
      else e.set('world');
    }
    expect(doc.commands[0]).toBe('echo hello');
    expect(doc.env.K).toBe('world');
  });

  it('set() writes back keys containing . / [ / ] (no silent drop)', () => {
    // Key literally contains dots and brackets — a flattened dotted field
    // string ("env.FOO.BAR[0]") would mis-parse and drop the write.
    const doc = { env: { 'FOO.BAR[0]': '{{ y }}' } };
    const entries = walkAndBind(doc, isTemplatable);
    expect(entries).toHaveLength(1);
    entries[0]!.set('resolved');
    expect(doc.env['FOO.BAR[0]']).toBe('resolved');
  });

  it('includeLiteralOnly returns fields whose only template content is a {{{{ escape', () => {
    const doc = { commands: ['echo {{{{value'] };
    // Default: literal-only fields are skipped.
    expect(walkAndBind(doc, isTemplatable)).toHaveLength(0);
    // Opt-in: returned so the {{{{ → {{ unescape can be written back.
    const entries = walkAndBind(doc, isTemplatable, true);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.field).toBe('commands[0]');
  });
});

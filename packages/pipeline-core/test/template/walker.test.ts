// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { walkAndBind } from '../../src/template/walker';

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
});

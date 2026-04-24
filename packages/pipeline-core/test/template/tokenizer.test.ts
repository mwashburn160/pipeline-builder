// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { tokenize, TokenizerError, hasTemplate, MAX_FIELD_SIZE_BYTES, MAX_PATH_DEPTH } from '../../src/template/tokenizer';

describe('tokenize', () => {
  it('returns a single literal for plain strings', () => {
    const t = tokenize('hello world');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'literal', value: 'hello world' });
  });

  it('extracts a single expression', () => {
    const t = tokenize('{{ pipeline.metadata.env }}');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'expr', path: ['pipeline', 'metadata', 'env'] });
  });

  it('handles mixed literal and expressions', () => {
    const t = tokenize('prefix-{{ vars.branch }}-suffix');
    expect(t).toHaveLength(3);
    expect(t[0]).toMatchObject({ kind: 'literal', value: 'prefix-' });
    expect(t[1]).toMatchObject({ kind: 'expr', path: ['vars', 'branch'] });
    expect(t[2]).toMatchObject({ kind: 'literal', value: '-suffix' });
  });

  it('parses a default filter with single quotes', () => {
    const t = tokenize('{{ vars.name | default: \'anonymous\' }}');
    expect(t[0]).toMatchObject({ kind: 'expr', defaultValue: 'anonymous' });
  });

  it('parses a default filter with double quotes', () => {
    const t = tokenize('{{ vars.name | default: "anon" }}');
    expect(t[0]).toMatchObject({ kind: 'expr', defaultValue: 'anon' });
  });

  it('supports escaped quotes inside default', () => {
    const t = tokenize('{{ x | default: \'can\\\'t\' }}');
    expect(t[0]).toMatchObject({ defaultValue: 'can\'t' });
  });

  it('treats {{{{ as a literal {{', () => {
    // `{{{{foo{{{{` unescapes to `{{foo{{`
    const t = tokenize('echo {{{{foo{{{{ more');
    expect(t).toHaveLength(1);
    expect(t[0]!.kind).toBe('literal');
    expect((t[0] as any).value).toBe('echo {{foo{{ more');
  });

  it('tracks source positions on literals and expressions', () => {
    const t = tokenize('a\n  {{ x.y }}');
    const expr = t.find(x => x.kind === 'expr');
    expect(expr!.pos).toEqual({ line: 2, col: 3 });
  });

  it('throws on unknown filter', () => {
    expect(() => tokenize('{{ x | upper }}')).toThrow(TokenizerError);
  });

  it('throws on missing }}', () => {
    expect(() => tokenize('{{ x')).toThrow(TokenizerError);
  });

  it('throws on stray }} outside expression', () => {
    expect(() => tokenize('foo }} bar')).toThrow(TokenizerError);
  });

  it('throws on empty expression', () => {
    expect(() => tokenize('{{ }}')).toThrow(TokenizerError);
  });

  it('throws when path depth exceeds max', () => {
    const parts = Array(MAX_PATH_DEPTH + 1).fill('a').join('.');
    expect(() => tokenize(`{{ ${parts} }}`)).toThrow(/depth/);
  });

  it('throws when field exceeds size cap', () => {
    const huge = 'x'.repeat(MAX_FIELD_SIZE_BYTES + 1);
    expect(() => tokenize(huge)).toThrow(/size/);
  });

  it('allows whitespace around tokens', () => {
    const t = tokenize('{{   a.b.c   |   default:   "x"   }}');
    expect(t[0]).toMatchObject({ kind: 'expr', path: ['a', 'b', 'c'], defaultValue: 'x' });
  });

  it('rejects unterminated quoted string', () => {
    expect(() => tokenize('{{ x | default: \'oops }}')).toThrow(/Unterminated/);
  });

  it('parses | number coercion filter', () => {
    const t = tokenize('{{ vars.n | number }}');
    expect(t[0]).toMatchObject({ kind: 'expr', coerce: 'number' });
  });

  it('parses | bool coercion filter', () => {
    const t = tokenize('{{ vars.b | bool }}');
    expect(t[0]).toMatchObject({ kind: 'expr', coerce: 'bool' });
  });

  it('parses | json coercion filter', () => {
    const t = tokenize('{{ vars.c | json }}');
    expect(t[0]).toMatchObject({ kind: 'expr', coerce: 'json' });
  });

  it('parses default + coercion chain', () => {
    const t = tokenize('{{ vars.x | default: \'0\' | number }}');
    expect(t[0]).toMatchObject({ kind: 'expr', defaultValue: '0', coerce: 'number' });
  });

  it('rejects duplicate coercion filters', () => {
    expect(() => tokenize('{{ x | number | bool }}')).toThrow('coercion');
  });

  it('rejects duplicate default filters', () => {
    expect(() => tokenize('{{ x | default: \'a\' | default: \'b\' }}')).toThrow('may only appear once');
  });
});

describe('hasTemplate', () => {
  it('returns false for plain strings', () => {
    expect(hasTemplate('no templates here')).toBe(false);
  });
  it('returns true when {{ is present', () => {
    expect(hasTemplate('abc {{ x }}')).toBe(true);
  });
});

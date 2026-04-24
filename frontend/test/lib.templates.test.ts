// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  tokenize,
  hasTemplate,
  resolve,
  validateSource,
  previewResolve,
  TokenizeError,
} from '../src/lib/templates';

describe('frontend templates: tokenize', () => {
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

  it('parses default + coercion chain', () => {
    const t = tokenize(`{{ vars.x | default: '0' | number }}`);
    expect(t[0]).toMatchObject({ kind: 'expr', defaultValue: '0', coerce: 'number' });
  });

  it('throws TokenizeError on malformed template', () => {
    expect(() => tokenize('{{ broken')).toThrow(TokenizeError);
  });
});

describe('frontend templates: resolve', () => {
  const scope = {
    pipeline: { metadata: { env: 'prod', count: 5 }, projectName: 'checkout' },
  };

  it('resolves a simple path', () => {
    expect(resolve(tokenize('{{ pipeline.metadata.env }}'), scope)).toBe('prod');
  });

  it('applies default when missing', () => {
    expect(resolve(tokenize(`{{ pipeline.x | default: 'y' }}`), scope)).toBe('y');
  });

  it('coerces to number when whole-field', () => {
    expect(resolve(tokenize('{{ pipeline.metadata.count | number }}'), scope)).toBe(5);
  });

  it('stays string when mixed with literal', () => {
    expect(resolve(tokenize('c={{ pipeline.metadata.count | number }}'), scope)).toBe('c=5');
  });
});

describe('frontend templates: validateSource', () => {
  it('valid → returns tokens + no error', () => {
    const v = validateSource('{{ pipeline.metadata.env }}');
    expect(v.valid).toBe(true);
    expect(v.tokens).toHaveLength(1);
  });

  it('invalid → returns error + position', () => {
    const v = validateSource('{{ broken');
    expect(v.valid).toBe(false);
    expect(v.error).toMatch(/Expected/);
    expect(v.errorPos).toBeDefined();
  });

  it('plain string → valid no-op', () => {
    const v = validateSource('plain');
    expect(v.valid).toBe(true);
  });
});

describe('frontend templates: previewResolve', () => {
  it('returns ok with resolved value', () => {
    const r = previewResolve('{{ x.y }}', { x: { y: 'hello' } });
    expect(r).toEqual({ ok: true, value: 'hello' });
  });

  it('returns error for undefined paths', () => {
    const r = previewResolve('{{ x.y }}', {});
    expect(r.ok).toBe(false);
  });
});

describe('frontend templates: hasTemplate', () => {
  it('detects template markers', () => {
    expect(hasTemplate('a {{ b }} c')).toBe(true);
    expect(hasTemplate('plain')).toBe(false);
  });
});

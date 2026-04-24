// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode } from '@pipeline-builder/api-core';
import { resolve, lookupPath, dependencies } from '../../src/template/evaluator';
import { tokenize } from '../../src/template/tokenizer';

describe('lookupPath', () => {
  it('returns nested string', () => {
    expect(lookupPath({ a: { b: 'x' } }, ['a', 'b'])).toBe('x');
  });
  it('returns undefined for missing segments', () => {
    expect(lookupPath({ a: {} }, ['a', 'b'])).toBeUndefined();
    expect(lookupPath({}, ['a', 'b', 'c'])).toBeUndefined();
  });
  it('handles arrays on the path (returns the array)', () => {
    expect(lookupPath({ a: [1, 2] }, ['a'])).toEqual([1, 2]);
  });
});

describe('resolve', () => {
  const scope = {
    pipeline: { metadata: { env: 'prod', replicas: 3 }, projectName: 'checkout' },
    plugin: { name: 'deploy', version: '1.0.0' },
  };

  it('resolves a single path', () => {
    const t = tokenize('env={{ pipeline.metadata.env }}');
    expect(resolve(t, scope)).toBe('env=prod');
  });

  it('coerces numbers and booleans to string', () => {
    expect(resolve(tokenize('n={{ pipeline.metadata.replicas }}'), scope)).toBe('n=3');
  });

  it('applies default when path is undefined', () => {
    expect(resolve(tokenize(`{{ x.y | default: 'fallback' }}`), {})).toBe('fallback');
  });

  it('applies default when path is empty string', () => {
    expect(resolve(tokenize(`{{ x.y | default: 'd' }}`), { x: { y: '' } })).toBe('d');
  });

  it('throws TEMPLATE_UNKNOWN_PATH when no default and path missing', () => {
    expect.assertions(1);
    try {
      resolve(tokenize('{{ x.y }}'), {});
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.TEMPLATE_UNKNOWN_PATH);
    }
  });

  it('throws TEMPLATE_SECRETS_RESERVED for secrets.* paths', () => {
    expect.assertions(1);
    try {
      resolve(tokenize('{{ secrets.api_key }}'), { secrets: { api_key: 'x' } });
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.TEMPLATE_SECRETS_RESERVED);
    }
  });

  it('throws TEMPLATE_TYPE_MISMATCH when path resolves to object', () => {
    expect.assertions(1);
    try {
      resolve(tokenize('{{ pipeline.metadata }}'), scope);
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.TEMPLATE_TYPE_MISMATCH);
    }
  });
});

describe('type coercion filters', () => {
  const scope = {
    vars: {
      count: 3,
      flag: 'true',
      config: '{"replicas":5,"env":"prod"}',
      empty: '',
    },
  };

  it('| number coerces to number when whole field', () => {
    expect(resolve(tokenize('{{ vars.count | number }}'), scope)).toBe(3);
  });

  it('| bool accepts true/false/yes/no/1/0', () => {
    expect(resolve(tokenize('{{ vars.flag | bool }}'), scope)).toBe(true);
    expect(resolve(tokenize(`{{ vars.x | default: 'no' | bool }}`), scope)).toBe(false);
    expect(resolve(tokenize(`{{ vars.x | default: '1' | bool }}`), scope)).toBe(true);
  });

  it('| json parses as JSON', () => {
    const out = resolve(tokenize('{{ vars.config | json }}'), scope) as Record<string, unknown>;
    expect(out).toEqual({ replicas: 5, env: 'prod' });
  });

  it('coercion is ignored when template is embedded in literal', () => {
    // Mixed-literal field always returns string (coercion only fires on whole-field exprs)
    expect(resolve(tokenize('count={{ vars.count | number }}'), scope)).toBe('count=3');
  });

  it('| number rejects non-numeric values', () => {
    expect.assertions(1);
    try {
      resolve(tokenize('{{ vars.flag | number }}'), scope);
    } catch (e: any) {
      expect(e.code).toBeDefined();
    }
  });

  it('| json rejects invalid JSON', () => {
    expect.assertions(1);
    try {
      // 'not valid json {' is not parseable
      resolve(tokenize(`{{ vars.x | default: 'not valid {' | json }}`), scope);
    } catch (e: any) {
      expect(e.code).toBeDefined();
    }
  });

  it('default + coercion chain', () => {
    expect(resolve(tokenize(`{{ vars.missing | default: '42' | number }}`), scope)).toBe(42);
  });
});

describe('dependencies', () => {
  it('returns dotted paths from expr tokens only', () => {
    const tokens = tokenize('hello {{ a.b }} {{ c.d.e }}');
    expect(dependencies(tokens)).toEqual(['a.b', 'c.d.e']);
  });
  it('returns empty when no exprs', () => {
    expect(dependencies(tokenize('plain'))).toEqual([]);
  });
});

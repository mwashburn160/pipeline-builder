// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode } from '@pipeline-builder/api-core';
import {
  validateTemplates,
  detectCycles,
  allowedScopeRoots,
} from '../../src/template/validate';

const isTemplatable = (f: string) =>
  f.startsWith('commands') || f.startsWith('env.') || f === 'description';

const isKnown = allowedScopeRoots(['pipeline', 'plugin', 'env']);

describe('validateTemplates', () => {
  it('passes for a valid doc', () => {
    const doc = {
      commands: ['{{ pipeline.metadata.env }}'],
      env: { S: '{{ plugin.name }}' },
    };
    const r = validateTemplates(doc, isTemplatable, isKnown);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports unknown scope root', () => {
    const doc = { commands: ['{{ foobar.x }}'] };
    const r = validateTemplates(doc, isTemplatable, isKnown);
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.code).toBe(ErrorCode.TEMPLATE_UNKNOWN_PATH);
  });

  it('reports reserved secrets.* path', () => {
    const doc = { commands: ['{{ secrets.db_password }}'] };
    const r = validateTemplates(doc, isTemplatable, isKnown);
    expect(r.errors[0]!.code).toBe(ErrorCode.TEMPLATE_SECRETS_RESERVED);
  });

  it('batches multiple errors', () => {
    const doc = {
      commands: [
        '{{ foo.bar }}',          // unknown
        '{{ secrets.x }}',        // reserved
        '{{ pipeline.meta.x }}',  // valid
      ],
    };
    const r = validateTemplates(doc, isTemplatable, isKnown);
    expect(r.errors).toHaveLength(2);
  });

  it('reports parse errors with position', () => {
    const doc = { commands: ['{{ broken'] };
    const r = validateTemplates(doc, isTemplatable, isKnown);
    expect(r.errors[0]!.code).toBe(ErrorCode.TEMPLATE_PARSE_ERROR);
    expect(r.errors[0]!.line).toBeDefined();
  });
});

describe('detectCycles', () => {
  const isSelfRefTemplatable = (f: string) => f.startsWith('metadata.') || f.startsWith('vars.');
  const fieldToScope = (f: string) => f;

  it('returns empty for acyclic doc', () => {
    const doc = { metadata: { env: 'prod', region: '{{ metadata.env }}' } };
    expect(detectCycles(doc, isSelfRefTemplatable, fieldToScope)).toEqual([]);
  });

  it('reports cycle', () => {
    const doc = {
      metadata: { a: '{{ metadata.b }}', b: '{{ metadata.a }}' },
    };
    const errors = detectCycles(doc, isSelfRefTemplatable, fieldToScope);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.code).toBe(ErrorCode.TEMPLATE_CYCLE);
  });
});

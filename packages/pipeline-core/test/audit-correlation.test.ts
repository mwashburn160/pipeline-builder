// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import {
  correlationHeaders,
  MAX_CORRELATION_VALUE,
  sanitizeCorrelationValue,
} from '../src/core/audit-correlation.js';

describe('audit-correlation', () => {
  it('strips CR/LF, whitespace and non-ASCII so a value cannot inject a header', () => {
    expect(sanitizeCorrelationValue('abc\r\nSet-Cookie: x')).toBe('abcSet-Cookie:x');
    expect(sanitizeCorrelationValue('id-é\u0000-1')).toBe('id--1');
  });

  it('caps the length and refuses empty / non-string values', () => {
    expect(sanitizeCorrelationValue('a'.repeat(500))).toHaveLength(MAX_CORRELATION_VALUE);
    expect(sanitizeCorrelationValue('\r\n ')).toBeUndefined();
    expect(sanitizeCorrelationValue(undefined)).toBeUndefined();
    expect(sanitizeCorrelationValue(42)).toBeUndefined();
  });

  it('includes only the ids that are known', () => {
    expect(correlationHeaders({ requestId: 'r-1' })).toEqual({ 'X-Request-Id': 'r-1' });
    expect(correlationHeaders({
      requestId: 'r-1',
      pipelineExecutionId: 'e-1',
      codeBuildBuildId: 'proj:uuid',
    })).toEqual({
      'X-Request-Id': 'r-1',
      'X-Pipeline-Execution-Id': 'e-1',
      'X-CodeBuild-Build-Id': 'proj:uuid',
    });
    expect(correlationHeaders({})).toEqual({});
  });
});

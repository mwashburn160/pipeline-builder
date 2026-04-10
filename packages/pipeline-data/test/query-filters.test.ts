// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { validateMessageFilter } from '../src/core/query-filters';

describe('validateMessageFilter', () => {
  it('should pass for valid filter', () => {
    const result = validateMessageFilter({ messageType: 'announcement', priority: 'high' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should pass for empty filter', () => {
    const result = validateMessageFilter({});
    expect(result.valid).toBe(true);
  });

  it('should reject invalid messageType', () => {
    const result = validateMessageFilter({ messageType: 'invalid' as any });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid messageType');
  });

  it('should reject invalid priority', () => {
    const result = validateMessageFilter({ priority: 'critical' as any });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid priority');
  });

  it('should accept null threadId for root messages', () => {
    const result = validateMessageFilter({ threadId: null });
    expect(result.valid).toBe(true);
  });

  it('should accept string threadId', () => {
    const result = validateMessageFilter({ threadId: 'some-uuid' });
    expect(result.valid).toBe(true);
  });
});

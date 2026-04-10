// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getContext } from '../src/api/get-context';

describe('getContext', () => {
  it('returns req.context when it exists', () => {
    const mockContext = {
      requestId: 'req-123',
      identity: { orgId: 'org-1', userId: 'user-1' },
      log: jest.fn(),
    };
    const req = { context: mockContext } as any;

    const result = getContext(req);

    expect(result).toBe(mockContext);
    expect(result.requestId).toBe('req-123');
    expect(result.identity.orgId).toBe('org-1');
  });

  it('throws a descriptive error when context is undefined', () => {
    const req = {} as any;

    expect(() => getContext(req)).toThrow(
      'Request context not initialized. Ensure attachRequestContext middleware is applied.',
    );
  });

  it('throws when context is explicitly null', () => {
    const req = { context: null } as any;

    expect(() => getContext(req)).toThrow(
      'Request context not initialized. Ensure attachRequestContext middleware is applied.',
    );
  });

  it('returns the exact same object reference', () => {
    const mockContext = {
      requestId: 'abc',
      identity: { orgId: 'x' },
      log: jest.fn(),
    };
    const req = { context: mockContext } as any;

    const result = getContext(req);
    expect(result).toBe(mockContext);
  });
});

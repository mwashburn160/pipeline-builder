// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

const mockCreate = jest.fn();
jest.mock('../src/models/audit-event', () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

import { audit } from '../src/helpers/audit';

function mockReq(overrides: {
  user?: Partial<{ sub: string; email: string; organizationId: string }>;
  ip?: string;
} = {}): any {
  return {
    user: overrides.user,
    ip: overrides.ip || '127.0.0.1',
  };
}

describe('audit helper', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({});
  });

  it('should record an audit event with actor info', () => {
    const req = mockReq({
      user: { sub: 'user-1', email: 'u@e.com', organizationId: 'org-1' },
      ip: '10.0.0.1',
    });

    audit(req, 'user.login');

    expect(mockCreate).toHaveBeenCalledWith({
      action: 'user.login',
      actorId: 'user-1',
      actorEmail: 'u@e.com',
      orgId: 'org-1',
      ip: '10.0.0.1',
    });
  });

  it('should default actorId to anonymous when no user', () => {
    audit(mockReq(), 'user.register');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'anonymous' }),
    );
  });

  it('should include target options', () => {
    const req = mockReq({ user: { sub: 'u1' } });
    audit(req, 'org.create', {
      targetType: 'organization',
      targetId: 'org-99',
      details: { field: 'name' },
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org.create',
        targetType: 'organization',
        targetId: 'org-99',
        details: { field: 'name' },
      }),
    );
  });

  it('should not throw when create rejects (fire-and-forget)', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));
    expect(() => audit(mockReq(), 'user.logout')).not.toThrow();
    // Allow microtask queue to flush so the .catch handler runs without leaking.
    await new Promise((r) => setImmediate(r));
  });

  it('should be synchronous and return undefined', () => {
    const result = audit(mockReq(), 'user.delete');
    expect(result).toBeUndefined();
  });
});

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

const mockCurrentTraceId = jest.fn<string | undefined, []>();
jest.mock('@pipeline-builder/api-server', () => ({
  currentTraceId: () => mockCurrentTraceId(),
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
  user?: Partial<{ sub: string; email: string; organizationId: string; role: string; impersonatorId: string }>;
  ip?: string;
  headers?: Record<string, string>;
} = {}): any {
  return {
    user: overrides.user,
    ip: overrides.ip || '127.0.0.1',
    headers: overrides.headers || {},
  };
}

/** True if the string contains any C0/DEL/C1 control character. Computed from
 *  char codes so this test source stays ASCII-only (no control-char literal). */
function hasControlChar(s: string): boolean {
  return [...s].some((c) => {
    const code = c.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

describe('audit helper', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({});
    mockCurrentTraceId.mockReset();
    mockCurrentTraceId.mockReturnValue(undefined);
  });

  it('should record an audit event with actor info + role', () => {
    const req = mockReq({
      user: { sub: 'user-1', email: 'u@e.com', organizationId: 'org-1', role: 'admin' },
      ip: '10.0.0.1',
    });

    audit(req, 'user.login');

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.login',
      actorId: 'user-1',
      actorEmail: 'u@e.com',
      actorRole: 'admin',
      orgId: 'org-1',
      // `affectedOrgId` defaults to the actor's own org for normal in-org
      // actions; sysadmin-impersonation paths override it explicitly.
      affectedOrgId: 'org-1',
      ip: '10.0.0.1',
      // outcome defaults to success when not specified.
      outcome: 'success',
    }));
  });

  it('should default actorId to anonymous when no user', () => {
    audit(mockReq(), 'user.register');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'anonymous' }));
  });

  it('should use the x-request-id header as the correlation id', () => {
    const req = mockReq({ user: { sub: 'u1' }, headers: { 'x-request-id': 'req-abc' } });
    audit(req, 'user.login');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-abc' }));
  });

  it('should fall back to a generated uuid when no request id header is present', () => {
    audit(mockReq({ user: { sub: 'u1' } }), 'user.login');
    const stored = mockCreate.mock.calls[0][0].requestId as string;
    // randomUUID() shape: 8-4-4-4-12 hex. Never empty.
    expect(stored).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should capture the active trace id when tracing is on', () => {
    mockCurrentTraceId.mockReturnValue('trace-xyz');
    audit(mockReq({ user: { sub: 'u1' } }), 'user.login');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ traceId: 'trace-xyz' }));
  });

  it('should capture the impersonator when acting under impersonation', () => {
    const req = mockReq({ user: { sub: 'target-user', impersonatorId: 'sysadmin-1' } });
    audit(req, 'dashboard.update');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ impersonatorId: 'sysadmin-1' }));
  });

  it('should promote groupId to a first-class field', () => {
    const req = mockReq({ user: { sub: 'u1', organizationId: 'org-1' } });
    audit(req, 'org.group.member.add', { targetType: 'user', targetId: 'u2', groupId: 'grp-7' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'grp-7' }));
  });

  it('should pass through an explicit failure outcome', () => {
    audit(mockReq({ user: { sub: 'u1' } }), 'user.login.failed', { outcome: 'failure' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure' }));
  });

  it('should capture and truncate the user-agent, stripping control chars', () => {
    const longUa = 'A'.repeat(600);
    const req = mockReq({ user: { sub: 'u1' }, headers: { 'user-agent': `Mozilla \n${longUa}` } });
    audit(req, 'user.login');
    const stored = mockCreate.mock.calls[0][0].userAgent as string;
    expect(stored.length).toBe(512);
    expect(hasControlChar(stored)).toBe(false);
    expect(stored.startsWith('Mozilla')).toBe(true);
  });

  it('should store undefined user-agent when the header is absent', () => {
    audit(mockReq({ user: { sub: 'u1' } }), 'user.login');
    expect(mockCreate.mock.calls[0][0].userAgent).toBeUndefined();
  });

  it('should include target options', () => {
    const req = mockReq({ user: { sub: 'u1' } });
    audit(req, 'org.create', {
      targetType: 'organization',
      targetId: 'org-99',
      details: { field: 'name' },
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.create',
      targetType: 'organization',
      targetId: 'org-99',
      details: { field: 'name' },
    }));
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

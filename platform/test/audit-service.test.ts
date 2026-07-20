// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const mockLean = jest.fn();
const mockLimit = jest.fn(() => ({ lean: mockLean }));
const mockSkip = jest.fn(() => ({ limit: mockLimit }));
const mockSort = jest.fn(() => ({ skip: mockSkip }));
const mockFind = jest.fn(() => ({ sort: mockSort }));
const mockCountDocuments = jest.fn();
const mockCreate = jest.fn();
// `createEvent` now delegates to the shared hash-chain append, which reads the
// chain tail via `findOne(...).sort(...).select(...).lean()`.
const mockFindOneLean = jest.fn();
const mockFindOne = jest.fn(() => ({ sort: () => ({ select: () => ({ lean: mockFindOneLean }) }) }));

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  __esModule: true,
  default: {
    find: mockFind,
    findOne: mockFindOne,
    countDocuments: mockCountDocuments,
    create: mockCreate,
  },
}));

const { auditService } = await import('../src/services/audit-service.js');


describe('auditService.findEvents', () => {
  beforeEach(() => {
    mockFind.mockClear();
    mockSort.mockClear();
    mockSkip.mockClear();
    mockLimit.mockClear();
    mockLean.mockReset();
    mockCountDocuments.mockReset();
  });

  it('should return events with pagination metadata', async () => {
    mockLean.mockResolvedValue([{ action: 'user.login' }]);
    mockCountDocuments.mockResolvedValue(1);

    const result = await auditService.findEvents({}, 0, 10);

    expect(result.events).toEqual([{ action: 'user.login' }]);
    expect(result.pagination).toEqual({ total: 1, offset: 0, limit: 10, hasMore: false });
  });

  it('should set hasMore=true when total exceeds offset+limit', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(100);

    const result = await auditService.findEvents({}, 0, 20);
    expect(result.pagination.hasMore).toBe(true);
  });

  it('should build query from filter fields', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    await auditService.findEvents(
      { orgId: 'org-1', action: 'login', targetType: 'user', targetId: 't-1' },
      5,
      10,
    );

    expect(mockFind).toHaveBeenCalledWith({
      orgId: 'org-1',
      action: { $regex: 'login', $options: 'i' },
      targetType: 'user',
      targetId: 't-1',
    });
    expect(mockSkip).toHaveBeenCalledWith(5);
    expect(mockLimit).toHaveBeenCalledWith(10);
  });

  it('should build query from the tracing + identity filter fields', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    await auditService.findEvents(
      { groupId: 'grp-1', impersonatorId: 'sa-1', outcome: 'failure', requestId: 'req-9' },
      0,
      10,
    );

    expect(mockFind).toHaveBeenCalledWith({
      groupId: 'grp-1',
      impersonatorId: 'sa-1',
      outcome: 'failure',
      requestId: 'req-9',
    });
  });

  it('should sort by createdAt descending', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    await auditService.findEvents({}, 0, 10);
    expect(mockSort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('should pass empty query when no filters', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    await auditService.findEvents({}, 0, 10);
    expect(mockFind).toHaveBeenCalledWith({});
  });

  it('should add affectedOrgId to the query when provided', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    await auditService.findEvents({ affectedOrgId: 'org-xyz' }, 0, 10);
    expect(mockFind).toHaveBeenCalledWith({ affectedOrgId: 'org-xyz' });
  });

  it('should add actorId to the query when provided', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    await auditService.findEvents({ actorId: 'user-abc' }, 0, 10);
    expect(mockFind).toHaveBeenCalledWith({ actorId: 'user-abc' });
  });

  it('should combine affectedOrgId, actorId, and action', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    await auditService.findEvents(
      { affectedOrgId: 'org-xyz', actorId: 'user-abc', action: 'kms-config' },
      0,
      10,
    );
    expect(mockFind).toHaveBeenCalledWith({
      affectedOrgId: 'org-xyz',
      actorId: 'user-abc',
      action: { $regex: 'kms-config', $options: 'i' },
    });
  });

  it('should escape regex metacharacters in the action filter', async () => {
    mockLean.mockResolvedValue([]);
    mockCountDocuments.mockResolvedValue(0);

    // Without escaping, `.*` would match everything and `(grant|revoke)` would
    // be a real regex group — neither is what a substring search promises.
    await auditService.findEvents({ action: 'admin.superadmin.grant' }, 0, 10);
    expect(mockFind).toHaveBeenCalledWith({
      action: { $regex: 'admin\\.superadmin\\.grant', $options: 'i' },
    });
  });
});

describe('auditService.createEvent', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockFindOne.mockClear();
    mockFindOneLean.mockReset();
    // Empty chain by default → first event gets prevHash null.
    mockFindOneLean.mockResolvedValue(null);
  });

  it('should create and return the event, tamper-evidence chained', async () => {
    const event = { action: 'user.register', actorId: 'u1' };
    mockCreate.mockResolvedValue(event);

    const result = await auditService.createEvent({ action: 'user.register', actorId: 'u1' });
    expect(result).toEqual(event);
    // Delegates to the shared append: the stored row now carries a sha256 hash
    // and (for a fresh chain) a null prevHash on top of the caller's fields.
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'user.register',
      actorId: 'u1',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prevHash: null,
    }));
  });

  it('should link prevHash to the chain tail returned by findOne', async () => {
    mockFindOneLean.mockResolvedValue({ hash: 'a'.repeat(64) });
    mockCreate.mockResolvedValue({});

    await auditService.createEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ prevHash: 'a'.repeat(64) }));
  });

  it('should propagate create errors', async () => {
    mockCreate.mockRejectedValue(new Error('db error'));
    await expect(
      auditService.createEvent({ action: 'user.login', actorId: 'u1' }),
    ).rejects.toThrow('db error');
  });
});


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

const mockLean = jest.fn();
const mockLimit = jest.fn(() => ({ lean: mockLean }));
const mockSkip = jest.fn(() => ({ limit: mockLimit }));
const mockSort = jest.fn(() => ({ skip: mockSkip }));
const mockFind = jest.fn(() => ({ sort: mockSort }));
const mockCountDocuments = jest.fn();
const mockCreate = jest.fn();

jest.mock('../src/models/audit-event', () => ({
  __esModule: true,
  default: {
    find: mockFind,
    countDocuments: mockCountDocuments,
    create: mockCreate,
  },
}));

import { auditService } from '../src/services/audit-service';

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
});

describe('auditService.createEvent', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('should create and return the event', async () => {
    const event = { action: 'user.register', actorId: 'u1' };
    mockCreate.mockResolvedValue(event);

    const result = await auditService.createEvent({ action: 'user.register', actorId: 'u1' });
    expect(result).toEqual(event);
    expect(mockCreate).toHaveBeenCalledWith({ action: 'user.register', actorId: 'u1' });
  });

  it('should propagate create errors', async () => {
    mockCreate.mockRejectedValue(new Error('db error'));
    await expect(
      auditService.createEvent({ action: 'user.login', actorId: 'u1' }),
    ).rejects.toThrow('db error');
  });
});

describe('auditService.createEventAsync', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('should call create without awaiting', () => {
    mockCreate.mockResolvedValue({});
    const result = auditService.createEventAsync({ action: 'user.logout', actorId: 'u1' });
    expect(result).toBeUndefined();
    expect(mockCreate).toHaveBeenCalled();
  });

  it('should swallow rejections', async () => {
    mockCreate.mockRejectedValue(new Error('boom'));
    expect(() => auditService.createEventAsync({ action: 'user.login', actorId: 'u1' })).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

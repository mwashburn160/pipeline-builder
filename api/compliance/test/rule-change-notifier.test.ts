// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockPost = jest.fn();
const mockFindSubscribers = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

jest.mock('../src/helpers/message-client', () => ({
  messageClient: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

jest.mock('../src/services/subscription-service', () => ({
  subscriptionService: {
    findSubscribers: (...args: unknown[]) => mockFindSubscribers(...args),
  },
}));

import { notifyPublishedRuleChange } from '../src/helpers/rule-change-notifier';

describe('notifyPublishedRuleChange', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockFindSubscribers.mockReset();
    mockPost.mockResolvedValue(undefined);
  });

  it('sends one message per subscriber for "updated"', async () => {
    mockFindSubscribers.mockResolvedValue([
      { orgId: 'org-1' },
      { orgId: 'org-2' },
    ]);

    await notifyPublishedRuleChange('rule-1', 'my-rule', 'updated');

    expect(mockFindSubscribers).toHaveBeenCalledWith('rule-1');
    expect(mockPost).toHaveBeenCalledTimes(2);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe('/messages');
    expect(body.recipientOrgId).toBe('org-1');
    expect(body.subject).toContain('updated');
    expect(body.subject).toContain('my-rule');
  });

  it('uses the deletion subject for "deleted"', async () => {
    mockFindSubscribers.mockResolvedValue([{ orgId: 'org-1' }]);

    await notifyPublishedRuleChange('rule-1', 'gone-rule', 'deleted');

    const [, body] = mockPost.mock.calls[0];
    expect(body.subject).toContain('removed');
    expect(body.content).toContain('deleted');
  });

  it('does not send messages when there are no subscribers', async () => {
    mockFindSubscribers.mockResolvedValue([]);

    await notifyPublishedRuleChange('rule-1', 'lonely', 'updated');

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('passes internal-service headers', async () => {
    mockFindSubscribers.mockResolvedValue([{ orgId: 'org-x' }]);

    await notifyPublishedRuleChange('rule-1', 'rn', 'updated');

    const [, , opts] = mockPost.mock.calls[0];
    expect(opts.headers['x-internal-service']).toBe('true');
    expect(opts.headers['x-org-id']).toBe('system');
  });

  it('swallows individual notification errors and continues', async () => {
    mockFindSubscribers.mockResolvedValue([{ orgId: 'a' }, { orgId: 'b' }]);
    mockPost.mockRejectedValueOnce(new Error('first failed'));
    mockPost.mockResolvedValueOnce(undefined);

    await expect(notifyPublishedRuleChange('rule-1', 'r', 'updated')).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('swallows top-level errors (findSubscribers throws)', async () => {
    mockFindSubscribers.mockRejectedValue(new Error('DB down'));

    await expect(notifyPublishedRuleChange('rule-1', 'r', 'updated')).resolves.toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockPost = jest.fn();

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

import { notifyComplianceBlock } from '../src/helpers/compliance-notifier';
import type { Violation } from '../src/engine/rule-engine';

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    ruleId: 'r1',
    ruleName: 'rule-1',
    field: 'name',
    operator: 'eq',
    expectedValue: 'a',
    actualValue: 'b',
    severity: 'error',
    message: 'mismatch',
    suppressNotification: false,
    ...overrides,
  };
}

describe('notifyComplianceBlock', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue(undefined);
  });

  it('sends a high-priority message with violation details', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'my-plugin', [makeViolation()], 'Bearer token');

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mockPost.mock.calls[0];
    expect(path).toBe('/messages');
    expect(body.recipientOrgId).toBe('org-1');
    expect(body.priority).toBe('high');
    expect(body.subject).toContain('plugin');
    expect(body.subject).toContain('my-plugin');
    expect(body.content).toContain('rule-1');
    expect(body.content).toContain('mismatch');
    expect(opts.headers.Authorization).toBe('Bearer token');
    expect(opts.headers['x-internal-service']).toBe('true');
  });

  it('skips when all violations have suppressNotification', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'name', [makeViolation({ suppressNotification: true })], 'auth');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips when violations array is empty', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'name', [], 'auth');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('filters out suppressed violations from the summary', async () => {
    await notifyComplianceBlock('org-1', 'plugin', 'p', [
      makeViolation({ ruleName: 'visible' }),
      makeViolation({ ruleName: 'hidden', suppressNotification: true }),
    ], 'auth');
    const [, body] = mockPost.mock.calls[0];
    expect(body.content).toContain('visible');
    expect(body.content).not.toContain('hidden');
  });

  it('swallows messageClient errors (fire-and-forget)', async () => {
    mockPost.mockRejectedValue(new Error('boom'));
    await expect(
      notifyComplianceBlock('org-1', 'plugin', 'p', [makeViolation()], 'auth'),
    ).resolves.toBeUndefined();
  });

  it('combines multiple violations into a single message', async () => {
    await notifyComplianceBlock('org-1', 'pipeline', 'pl', [
      makeViolation({ ruleName: 'r-a', message: 'A failed' }),
      makeViolation({ ruleName: 'r-b', message: 'B failed' }),
    ], 'auth');
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    expect(body.content).toContain('r-a');
    expect(body.content).toContain('r-b');
  });
});

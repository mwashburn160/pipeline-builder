// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-app notification delivery: one delivery path for both variants, and a
 * non-2xx from the message service is a logged failed delivery — not silence.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPost = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockWarn = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() }),
  createSafeClient: () => ({ post: mockPost }),
  getServiceAuthHeader: () => 'Bearer svc',
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { message: { enabled: true, serviceHost: 'message', servicePort: 3000, serviceTimeout: 5000 } },
}));

const { sendInAppNotification, sendInAppNotificationConfirmed } = await import('../src/helpers/in-app-notify.js');
const notice = { recipientOrgId: 'org-1', subject: 's', content: 'c' };

beforeEach(() => jest.clearAllMocks());

describe('in-app notifications', () => {
  it('confirmed: a 2xx is delivered', async () => {
    mockPost.mockResolvedValue({ statusCode: 201 });
    await expect(sendInAppNotificationConfirmed(notice)).resolves.toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it.each([[{ statusCode: 500 }, 500], [null, 'unreachable']])('confirmed: %j is a LOGGED failed delivery', async (result, statusCode) => {
    mockPost.mockResolvedValue(result);
    await expect(sendInAppNotificationConfirmed(notice)).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ recipientOrgId: 'org-1', statusCode }));
  });

  it('fire-and-forget: goes through the same delivery path, logs a non-2xx, never throws', async () => {
    mockPost.mockResolvedValue({ statusCode: 503 });
    await expect(sendInAppNotification(notice)).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith('/messages/internal/notify', notice, expect.anything());
    expect(mockWarn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ statusCode: 503 }));

    mockPost.mockRejectedValue(new Error('boom'));
    await expect(sendInAppNotification(notice)).resolves.toBeUndefined();
  });
});

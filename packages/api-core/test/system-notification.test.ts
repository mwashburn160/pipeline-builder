// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const post = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const createSafeClient = jest.fn((_cfg: unknown) => ({ post }));
jest.unstable_mockModule('../src/services/http-client.js', () => ({ createSafeClient }));
jest.unstable_mockModule('../src/middleware/service-tokens.js', () => ({
  getServiceAuthHeader: (o: { serviceName: string; orgId: string }) => `Bearer ${o.serviceName}:${o.orgId}`,
}));

const { sendSystemNotification, SYSTEM_NOTIFY_PATH } = await import('../src/services/system-notification.js');

const N = { recipientOrgId: 'org-1', subject: 's', content: 'c' };

describe('sendSystemNotification', () => {
  beforeEach(() => { post.mockReset(); createSafeClient.mockClear(); });

  it('posts to the internal notify route with a service token scoped to the recipient', async () => {
    post.mockResolvedValue({ statusCode: 201, body: {} });
    await expect(sendSystemNotification(N, { serviceName: 'billing' })).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith(SYSTEM_NOTIFY_PATH, N, { headers: { authorization: 'Bearer billing:org-1' } });
    expect(createSafeClient).toHaveBeenCalledWith({ host: 'message', port: 3000 });
  });

  it.each([[400], [403], [500]])('reports a %i refusal as not delivered', async (statusCode) => {
    post.mockResolvedValue({ statusCode, body: {} });
    await expect(sendSystemNotification(N)).resolves.toBe(false);
  });

  it('reports an unreachable service or a thrown error as not delivered', async () => {
    post.mockResolvedValueOnce(null);
    await expect(sendSystemNotification(N)).resolves.toBe(false);
    post.mockRejectedValueOnce(new Error('boom'));
    await expect(sendSystemNotification(N)).resolves.toBe(false);
  });
});

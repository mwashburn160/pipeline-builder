// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockLookup = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: () => 'Bearer test-service-token',
}));

// Force a PUBLIC resolution so the up-front SSRF guard passes and the test can
// exercise the redirect handling in the fetch path.
jest.unstable_mockModule('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

// notification-channels imports these clients at module load; stub so their real
// InternalHttpClient imports don't run.
jest.unstable_mockModule('../src/helpers/message-client.js', () => ({
  messageClient: { post: jest.fn(async () => undefined) },
}));
jest.unstable_mockModule('../src/helpers/email-client.js', () => ({
  emailClient: { post: jest.fn(async () => undefined) },
}));

const { webhookChannel } = await import('../src/helpers/notification-channels.js');

const notification = {
  recipientOrgId: 'org-1',
  subject: 's',
  content: 'c',
  priority: 'normal' as const,
  messageType: 'announcement' as const,
  payload: { foo: 'bar' },
};

const realFetch = globalThis.fetch;
const mockFetch = jest.fn<(...args: unknown[]) => Promise<Response>>();

describe('webhookChannel SSRF / redirect handling', () => {
  beforeEach(() => {
    mockLookup.mockReset();
    // A public address — clears assertSafeWebhookUrl.
    mockLookup.mockResolvedValue([{ address: '93.184.216.34' }]);
    mockFetch.mockReset();
    (globalThis as { fetch: unknown }).fetch = mockFetch;
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('uses redirect: manual on the fetch', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, type: 'default' } as unknown as Response);

    await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x' });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.redirect).toBe('manual');
  });

  it('treats a 3xx redirect response as a FAILED delivery (not a false green)', async () => {
    // Attacker-controlled public host 302s to the metadata endpoint. The guard
    // passed on the initial host; fetch must not follow, and this must not count
    // as a successful notification.
    mockFetch.mockResolvedValue({ ok: false, status: 302, type: 'default' } as unknown as Response);

    const result = await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(302);
  });

  it('treats an opaqueredirect response as a FAILED delivery', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect' } as unknown as Response);

    const result = await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x' });

    expect(result.ok).toBe(false);
  });

  it('reports success for a 2xx delivery', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, type: 'default' } as unknown as Response);

    const result = await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x' });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(200);
  });

  it('rejects a webhook host that resolves to a private address (guard intact)', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254' }]);

    const result = await webhookChannel.deliver(notification, { url: 'https://sneaky.example.com/x' });

    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

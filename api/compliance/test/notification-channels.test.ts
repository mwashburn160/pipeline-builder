// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockLookup = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: () => 'Bearer test-service-token',
}));

// Control the up-front SSRF resolve independently from the send.
jest.unstable_mockModule('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

// Capture the https.request options (to prove the vetted IP is pinned) and drive
// a synthetic response with a configurable status code.
let capturedOptions: Record<string, unknown> | null = null;
const responseCtl = { statusCode: 200 };
const mockHttpsRequest = jest.fn((options: Record<string, unknown>, cb: (res: unknown) => void) => {
  capturedOptions = options;
  const res = {
    statusCode: responseCtl.statusCode,
    resume: jest.fn(),
    on: (evt: string, handler: (...a: unknown[]) => void) => {
      if (evt === 'end') handler();
      return res;
    },
  };
  // Invoke the response callback asynchronously, like the real client.
  queueMicrotask(() => cb(res));
  const req = { on: jest.fn(() => req), end: jest.fn() };
  return req;
});

jest.unstable_mockModule('https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(args[0] as Record<string, unknown>, args[1] as (res: unknown) => void),
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

describe('webhookChannel SSRF / DNS-rebinding handling', () => {
  beforeEach(() => {
    mockLookup.mockReset();
    // A public address — clears resolveSafeWebhookTarget.
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockHttpsRequest.mockClear();
    capturedOptions = null;
    responseCtl.statusCode = 200;
  });

  it('pins the validated IP into the connection and preserves Host/SNI (defeats rebinding)', async () => {
    const result = await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x' });

    expect(result.ok).toBe(true);
    // The host is resolved exactly ONCE (up-front validation). The send must not
    // re-resolve — that second lookup is the rebinding hole.
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    // SNI + Host stay the original hostname so cert validation is unchanged.
    expect(capturedOptions?.servername).toBe('hooks.example.com');
    expect(capturedOptions?.hostname).toBe('hooks.example.com');

    // The pinned lookup short-circuits DNS to the vetted public IP — a rebind
    // that would now resolve to a private address can never take effect because
    // this function never consults DNS again.
    const pinnedLookup = capturedOptions?.lookup as (
      h: string, o: unknown, cb: (e: Error | null, a: string, f: number) => void,
    ) => void;
    const cb = jest.fn();
    pinnedLookup('hooks.example.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(mockLookup).toHaveBeenCalledTimes(1); // still once — no re-resolution
  });

  it('treats a 3xx redirect response as a FAILED delivery (not a false green)', async () => {
    // https.request never auto-follows, so a redirect surfaces as its status and
    // must be recorded as a failed delivery, not a success.
    responseCtl.statusCode = 302;

    const result = await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x' });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(302);
  });

  it('signs the body when a secret is configured', async () => {
    await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x', secret: 's3cr3t' });

    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers['X-PB-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('reports success for a 2xx delivery', async () => {
    responseCtl.statusCode = 200;

    const result = await webhookChannel.deliver(notification, { url: 'https://hooks.example.com/x' });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(200);
  });

  it('rejects a webhook host that resolves to a private address (guard intact) and never connects', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const result = await webhookChannel.deliver(notification, { url: 'https://sneaky.example.com/x' });

    expect(result.ok).toBe(false);
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('rejects a non-https webhook url before resolving', async () => {
    const result = await webhookChannel.deliver(notification, { url: 'http://hooks.example.com/x' });

    expect(result.ok).toBe(false);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared SSRF guard (utils/ssrf): the private-range denylist,
 * the URL validator (protocol + host-literal + DNS-resolution checks), and the
 * pinned-connection `safeFetch`. `dns/promises` and `http(s)` are mocked so the
 * resolver and the socket are deterministic and nothing leaves the box.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockLookup = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockRequest = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('https', () => ({ request: (...args: any[]) => mockRequest(...args) }));
jest.unstable_mockModule('http', () => ({ request: (...args: any[]) => mockRequest(...args) }));

const { isPrivateAddress, assertSafeUrl, resolveSafeTarget, safeFetch } = await import('../src/utils/ssrf.js');

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34' }]); // public by default
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '::1', '::', '::ffff:127.0.0.1', 'fc00::1', 'fd12::1', 'fe80::1',
    '::ffff:7f00:1', // hex-mapped 127.0.0.1
    '::ffff:c0a8:1', // hex-mapped 192.168.0.1
  ])('flags private/loopback/metadata address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111',
    '::ffff:5db8:d822', // hex-mapped 93.184.216.34 (public) — must stay allowed
  ])(
    'allows public address %s', (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe('assertSafeUrl', () => {
  it('rejects a non-https url by default', async () => {
    await expect(assertSafeUrl('http://example.com/x')).rejects.toThrow(/https/);
  });

  it('rejects a malformed url', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toThrow(/invalid url/);
  });

  it('rejects an https url whose host is a private IP literal (no DNS needed)', async () => {
    await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private address/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects an https host that RESOLVES to a private address (DNS rebinding)', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254' }]);
    await expect(assertSafeUrl('https://sneaky.example.com/x')).rejects.toThrow(/private address/);
  });

  it('rejects a host that does not resolve', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeUrl('https://nope.example.com/x')).rejects.toThrow(/did not resolve/);
  });

  it('passes an https host that resolves to a public address', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34' }]);
    await expect(assertSafeUrl('https://example.com/hook')).resolves.toBeUndefined();
  });

  it('honors a custom protocol allowlist', async () => {
    await expect(assertSafeUrl('http://example.com/x', { protocols: ['http:', 'https:'] })).resolves.toBeUndefined();
  });
});

/**
 * Minimal `https.request` double: invokes the response callback with a fake
 * IncomingMessage that emits `body` then `end`. The options it was handed are
 * recorded so the address PINNING can be asserted.
 */
function stubResponse(status: number, body: string, headers: Record<string, string> = {}) {
  mockRequest.mockImplementation((_opts: any, cb: any) => {
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
    const res: any = {
      statusCode: status,
      statusMessage: 'OK',
      headers,
      on: (ev: string, fn: (arg?: unknown) => void) => { (listeners[ev] ??= []).push(fn); return res; },
      resume: () => { setImmediate(() => listeners.end?.forEach((f) => f())); },
      destroy: () => {},
    };
    setImmediate(() => {
      cb(res);
      if (status < 300 || status >= 400) {
        setImmediate(() => {
          listeners.data?.forEach((f) => f(Buffer.from(body, 'utf8')));
          listeners.end?.forEach((f) => f());
        });
      }
    });
    return { on: () => {}, end: () => {} };
  });
}

describe('resolveSafeTarget', () => {
  it('pins the resolved address, keeping the hostname for Host/SNI', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(resolveSafeTarget('https://example.com:8443/hook')).resolves.toEqual({
      host: 'example.com', address: '93.184.216.34', family: 4, port: 8443, protocol: 'https:',
    });
  });

  it('defaults the port per protocol', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect((await resolveSafeTarget('https://example.com/x')).port).toBe(443);
    expect((await resolveSafeTarget('http://example.com/x', { protocols: ['http:'] })).port).toBe(80);
  });
});

describe('safeFetch', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuses a private host before opening any socket', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(safeFetch('https://sneaky.example.com/x')).rejects.toThrow(/private address/);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('connects ONLY to the vetted address — the socket never re-resolves', async () => {
    stubResponse(200, '{"ok":true}');
    await safeFetch('https://example.com/hook', { method: 'POST', body: '{}' });

    const opts = mockRequest.mock.calls[0][0];
    expect(opts.hostname).toBe('example.com'); // Host + SNI stay the hostname
    expect(opts.servername).toBe('example.com');
    // The pinned lookup short-circuits DNS with the address already vetted.
    const pinned = await new Promise<string>((resolve) => {
      opts.lookup('example.com', {}, (_e: unknown, address: string) => resolve(address));
    });
    expect(pinned).toBe('93.184.216.34');
  });

  it('reports a 3xx as a refused redirect, never following it', async () => {
    stubResponse(302, '', { location: 'http://169.254.169.254/' });
    const resp = await safeFetch('https://example.com/hook');
    expect(resp.redirected).toBe(true);
    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(302);
    expect(mockRequest).toHaveBeenCalledTimes(1); // no second request
  });

  it('rejects a body larger than the cap', async () => {
    stubResponse(200, 'x'.repeat(200));
    await expect(safeFetch('https://example.com/x', { maxResponseBytes: 50 }))
      .rejects.toThrow(/exceeds 50 bytes/);
  });

  it('rejects early on an oversized Content-Length', async () => {
    stubResponse(200, 'x', { 'content-length': '999999' });
    await expect(safeFetch('https://example.com/x', { maxResponseBytes: 10 }))
      .rejects.toThrow(/exceeds 10 bytes/);
  });

  it('parses a JSON body and exposes the status', async () => {
    stubResponse(200, '{"default_branch":"main"}');
    const resp = await safeFetch('https://example.com/x');
    expect(resp.ok).toBe(true);
    expect(resp.json()).toEqual({ default_branch: 'main' });
  });
});

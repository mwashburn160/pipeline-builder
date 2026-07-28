// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared SSRF guard (utils/ssrf): the private-range denylist,
 * the URL validator (protocol + host-literal + DNS-resolution checks), and the
 * redirect-refusal helper. `dns/promises` is mocked so the resolver is
 * deterministic and no real lookups happen.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockLookup = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

const { isPrivateAddress, assertSafeUrl, isRefusedRedirect } = await import('../src/utils/ssrf.js');

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

describe('isRefusedRedirect', () => {
  it('flags 3xx and opaqueredirect responses, not 2xx', () => {
    expect(isRefusedRedirect({ status: 302, type: 'default' })).toBe(true);
    expect(isRefusedRedirect({ status: 0, type: 'opaqueredirect' })).toBe(true);
    expect(isRefusedRedirect({ status: 200, type: 'default' })).toBe(false);
  });
});

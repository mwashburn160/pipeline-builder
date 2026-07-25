// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the inline-login path of ensurePlatformToken.
 *
 * Previously the no-token+creds branch resolved config via getConfig(), which
 * THROWS "PLATFORM_TOKEN required" before the login POST could run — making
 * store-token/setup-events/provision --with-events dead-on-arrival when only
 * creds were supplied. The fix resolves the base URL token-optionally, so login
 * proceeds and sets PLATFORM_TOKEN.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockPost = jest.fn<() => Promise<{ data: unknown }>>();

jest.unstable_mockModule('axios', () => ({
  __esModule: true,
  default: { post: mockPost },
}));

const { ensurePlatformToken } = await import('../src/utils/platform-secret.js');

const ENV_KEYS = ['PLATFORM_TOKEN', 'PLATFORM_IDENTIFIER', 'PLATFORM_PASSWORD', 'PLATFORM_BASE_URL'] as const;
let saved: Record<string, string | undefined>;

describe('ensurePlatformToken — pre-auth inline login', () => {
  beforeEach(() => {
    saved = {};
    ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; });
    ENV_KEYS.forEach((k) => { delete process.env[k]; });
    mockPost.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    });
  });

  it('logs in WITHOUT a pre-existing PLATFORM_TOKEN and sets it (no "token required" throw)', async () => {
    process.env.PLATFORM_BASE_URL = 'https://api.example.com';
    mockPost.mockResolvedValue({ data: { data: { accessToken: 'fresh.jwt.token' } } });

    await expect(
      ensurePlatformToken({ email: 'admin@example.com', password: 'pw' }),
    ).resolves.toBeUndefined();

    // Login POST targeted the token-optionally resolved base URL.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe('https://api.example.com/api/auth/login');
    expect(process.env.PLATFORM_TOKEN).toBe('fresh.jwt.token');
  });

  it('is a no-op when PLATFORM_TOKEN is already set', async () => {
    process.env.PLATFORM_TOKEN = 'existing';
    await ensurePlatformToken({ email: 'a@b.c', password: 'pw' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('does nothing (no throw) when neither token nor creds are available', async () => {
    await expect(ensurePlatformToken({})).resolves.toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
    expect(process.env.PLATFORM_TOKEN).toBeUndefined();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI's session store — what `auth login` writes and every other command
 * reads.
 *
 * It holds live bearer credentials, so the file permissions are part of the
 * contract, not a detail. The per-platform keying matters too: one laptop
 * routinely talks to a local platform and a hosted one, and handing the wrong
 * platform's token over is both a failure and a credential leak.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';

// The module resolves its path at import time from os.homedir(), so the spy has
// to be installed before the dynamic import below.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-cred-'));
const realHomedir = os.homedir;
jest.spyOn(os, 'homedir').mockImplementation(() => home);

const { saveSession, loadSession, clearSession, isSessionUsable, credentialStorePath } =
  await import('../src/utils/credential-store.js');

const URL_A = 'https://platform.example.com';
const URL_B = 'https://localhost:8443';

function session(overrides: Partial<{ accessToken: string; refreshToken: string; expiresAt: number; organizationId: string }> = {}) {
  return {
    accessToken: 'access.jwt',
    refreshToken: 'refresh.jwt',
    expiresAt: Date.now() + 900_000,
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(path.join(home, '.pipeline-manager'), { recursive: true, force: true });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  os.homedir = realHomedir;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('credential store', () => {
  it('round-trips a session for one platform', () => {
    saveSession(URL_A, session({ organizationId: 'org-1' }));

    const loaded = loadSession(URL_A);
    expect(loaded).toMatchObject({ accessToken: 'access.jwt', refreshToken: 'refresh.jwt', organizationId: 'org-1' });
    expect(loaded?.savedAt).toBeTruthy();
  });

  it('keeps each platform\'s session apart', () => {
    saveSession(URL_A, session({ accessToken: 'hosted.jwt' }));
    saveSession(URL_B, session({ accessToken: 'local.jwt' }));

    expect(loadSession(URL_A)?.accessToken).toBe('hosted.jwt');
    expect(loadSession(URL_B)?.accessToken).toBe('local.jwt');
  });

  it('treats a trailing slash and casing as the same platform', () => {
    saveSession(URL_A, session({ accessToken: 'one.jwt' }));
    saveSession('https://PLATFORM.example.com/', session({ accessToken: 'two.jwt' }));

    expect(loadSession(URL_A)?.accessToken).toBe('two.jwt');
    expect(Object.keys(JSON.parse(fs.readFileSync(credentialStorePath(), 'utf-8')).sessions)).toHaveLength(1);
  });

  it('writes the store owner-only, inside an owner-only directory', () => {
    saveSession(URL_A, session());

    // The low three octal digits are the permission bits.
    expect(fs.statSync(credentialStorePath()).mode.toString(8).slice(-3)).toBe('600');
    expect(fs.statSync(path.dirname(credentialStorePath())).mode.toString(8).slice(-3)).toBe('700');
  });

  it('leaves no temp file behind', () => {
    saveSession(URL_A, session());
    expect(fs.existsSync(`${credentialStorePath()}.tmp`)).toBe(false);
  });

  it('forgets one platform without touching the others', () => {
    saveSession(URL_A, session());
    saveSession(URL_B, session());

    clearSession(URL_A);

    expect(loadSession(URL_A)).toBeUndefined();
    expect(loadSession(URL_B)).toBeDefined();
  });

  it('reads a missing or corrupt store as empty rather than throwing', () => {
    expect(loadSession(URL_A)).toBeUndefined();

    fs.mkdirSync(path.dirname(credentialStorePath()), { recursive: true });
    fs.writeFileSync(credentialStorePath(), 'not json at all');
    expect(loadSession(URL_A)).toBeUndefined();

    // And a login still recovers the file.
    saveSession(URL_A, session());
    expect(loadSession(URL_A)?.accessToken).toBe('access.jwt');
  });

  it('calls an expired (or nearly expired) access token unusable', () => {
    expect(isSessionUsable(undefined)).toBe(false);
    expect(isSessionUsable({ accessToken: 'a', expiresAt: Date.now() - 1, savedAt: '' })).toBe(false);
    // Inside the refresh skew: technically alive, but not worth sending.
    expect(isSessionUsable({ accessToken: 'a', expiresAt: Date.now() + 30_000, savedAt: '' })).toBe(false);
    expect(isSessionUsable({ accessToken: 'a', expiresAt: Date.now() + 900_000, savedAt: '' })).toBe(true);
  });
});

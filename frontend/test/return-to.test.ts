// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  POST_SIGN_IN_KEY,
  forgetReturnPath,
  peekReturnPath,
  rememberReturnPath,
  sanitizeReturnPath,
  takeReturnPath,
} from '../src/lib/return-to';

describe('sanitizeReturnPath', () => {
  it.each([
    ['/dashboard/pipelines', '/dashboard/pipelines'],
    ['/dashboard/pipelines?status=failed&page=2', '/dashboard/pipelines?status=failed&page=2'],
    ['/dashboard/security#sessions', '/dashboard/security#sessions'],
    ['/auth/device?user_code=BCDF-GHJK', '/auth/device?user_code=BCDF-GHJK'],
    ['/dashboard/../dashboard/audit', '/dashboard/audit'],
  ])('accepts in-app path %s', (input, expected) => {
    expect(sanitizeReturnPath(input)).toBe(expected);
  });

  it.each([
    ['absolute https URL', 'https://evil.example/dashboard'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: scheme', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative', '//evil.example/x'],
    ['backslash host', '/\\evil.example'],
    ['double backslash', '\\\\evil.example'],
    ['encoded protocol-relative', '/%2F%2Fevil.example'],
    ['encoded backslash', '/%5Cevil.example'],
    ['tab injection', '/\t/evil.example'],
    ['newline injection', '/dashboard\n//evil'],
    ['leading space', ' /dashboard'],
    ['relative without slash', 'dashboard'],
    ['empty', ''],
    ['landing page', '/'],
    ['landing with query', '/?expired=1'],
    ['oauth callback loop', '/auth/callback/google?code=x&state=y'],
    ['sso callback loop', '/auth/sso/org-1/callback'],
    ['register', '/auth/register'],
    ['auth root', '/auth'],
    ['malformed escape', '/dashboard/%E0%A4%A'],
    ['over-long', `/dashboard/${'a'.repeat(3000)}`],
  ])('rejects %s', (_label, input) => {
    expect(sanitizeReturnPath(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(sanitizeReturnPath(undefined)).toBeNull();
    expect(sanitizeReturnPath(null)).toBeNull();
    expect(sanitizeReturnPath({ toString: () => '/dashboard' })).toBeNull();
  });
});

describe('remember / take', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    forgetReturnPath();
  });

  it('defaults to the dashboard when nothing was remembered', () => {
    expect(takeReturnPath()).toBe('/dashboard');
  });

  it('returns the remembered path once, then the dashboard after the claim window', () => {
    jest.useFakeTimers();
    try {
      rememberReturnPath('/dashboard/executions?status=failed');
      expect(takeReturnPath()).toBe('/dashboard/executions?status=failed');
      expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBeNull();
      // A racing second reader in the same sign-in reaches the same answer.
      expect(takeReturnPath()).toBe('/dashboard/executions?status=failed');
      jest.advanceTimersByTime(11_000);
      expect(takeReturnPath()).toBe('/dashboard');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never stores an unsafe path', () => {
    rememberReturnPath('https://evil.example');
    expect(window.sessionStorage.getItem(POST_SIGN_IN_KEY)).toBeNull();
    expect(takeReturnPath()).toBe('/dashboard');
  });

  it('re-sanitizes a value planted directly in storage', () => {
    window.sessionStorage.setItem(POST_SIGN_IN_KEY, '//evil.example');
    expect(peekReturnPath()).toBeNull();
    expect(takeReturnPath()).toBe('/dashboard');
  });

  it('prefers a safe explicit candidate (OAuth returnUrl) and ignores an unsafe one', () => {
    rememberReturnPath('/dashboard/plugins');
    expect(takeReturnPath('/dashboard/audit')).toBe('/dashboard/audit');
    forgetReturnPath();
    rememberReturnPath('/dashboard/plugins');
    expect(takeReturnPath('https://evil.example')).toBe('/dashboard/plugins');
  });

  it('peek does not consume; forget drops it', () => {
    rememberReturnPath('/dashboard/plugins');
    expect(peekReturnPath()).toBe('/dashboard/plugins');
    expect(peekReturnPath()).toBe('/dashboard/plugins');
    forgetReturnPath();
    expect(takeReturnPath()).toBe('/dashboard');
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { isLocalHttpsHost, httpsAgentForUrl, relaxTlsForCli } from '../src/utils/tls.js';

describe('isLocalHttpsHost', () => {
  it('treats localhost / loopback / private ranges as local', () => {
    for (const u of ['https://localhost:8443', 'https://127.0.0.1', 'https://foo.local', 'https://10.1.2.3', 'https://192.168.0.9', 'https://172.16.5.5']) {
      expect(isLocalHttpsHost(u)).toBe(true);
    }
  });
  it('treats real domains as non-local', () => {
    expect(isLocalHttpsHost('https://api.example.com')).toBe(false);
    expect(httpsAgentForUrl('https://api.example.com')).toBeUndefined();
  });
});

describe('relaxTlsForCli', () => {
  let savedNodeEnv: string | undefined;
  let savedTls: string | undefined;
  const warn = jest.fn();

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    warn.mockReset();
  });
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTls;
  });

  it('does nothing when verifySsl is not explicitly false', () => {
    process.env.NODE_ENV = 'development';
    expect(relaxTlsForCli(undefined, warn)).toBe(false);
    expect(relaxTlsForCli(true, warn)).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it('disables TLS in non-production when --no-verify-ssl is passed', () => {
    process.env.NODE_ENV = 'development';
    expect(relaxTlsForCli(false, warn)).toBe(true);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
    expect(warn).not.toHaveBeenCalled();
  });

  it('REFUSES to disable TLS in production and warns instead', () => {
    process.env.NODE_ENV = 'production';
    expect(relaxTlsForCli(false, warn)).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/production/i);
  });
});

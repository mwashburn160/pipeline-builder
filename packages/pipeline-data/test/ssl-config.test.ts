// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for getSslConfig — env-driven Postgres TLS resolution in
 * postgres-connection.ts. Asserts the production-default-ON / local-default-OFF
 * behavior plus the DB_SSL / PGSSLMODE / explicit-option precedence.
 *
 * api-core is mocked (createLogger only) so importing the real connection module
 * doesn't pull in its full runtime graph; the module has no import-time side
 * effects (the pool is built lazily on getInstance()).
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { getSslConfig } = await import('../src/database/postgres-connection.js');

const ORIGINAL = {
  NODE_ENV: process.env.NODE_ENV,
  DB_SSL: process.env.DB_SSL,
  PGSSLMODE: process.env.PGSSLMODE,
  DB_SSL_REJECT_UNAUTHORIZED: process.env.DB_SSL_REJECT_UNAUTHORIZED,
};

function clearSslEnv() {
  delete process.env.DB_SSL;
  delete process.env.PGSSLMODE;
  delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
}

beforeEach(() => {
  clearSslEnv();
  delete process.env.NODE_ENV;
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('getSslConfig', () => {
  it('defaults ON in production (encrypted, verification opt-in)', () => {
    process.env.NODE_ENV = 'production';
    expect(getSslConfig()).toEqual({ rejectUnauthorized: false });
  });

  it('defaults OFF outside production so local Postgres without TLS still works', () => {
    process.env.NODE_ENV = 'development';
    expect(getSslConfig()).toBe(false);
    process.env.NODE_ENV = 'test';
    expect(getSslConfig()).toBe(false);
    delete process.env.NODE_ENV;
    expect(getSslConfig()).toBe(false);
  });

  it('DB_SSL=true enables TLS even in local/dev', () => {
    process.env.NODE_ENV = 'development';
    process.env.DB_SSL = 'true';
    expect(getSslConfig()).toEqual({ rejectUnauthorized: false });
    process.env.DB_SSL = '1';
    expect(getSslConfig()).toEqual({ rejectUnauthorized: false });
  });

  it('DB_SSL=false disables TLS even in production (explicit env override)', () => {
    process.env.NODE_ENV = 'production';
    process.env.DB_SSL = 'false';
    expect(getSslConfig()).toBe(false);
    process.env.DB_SSL = '0';
    expect(getSslConfig()).toBe(false);
  });

  it('honors PGSSLMODE (disable = off, any other mode = on)', () => {
    process.env.NODE_ENV = 'development';
    process.env.PGSSLMODE = 'require';
    expect(getSslConfig()).toEqual({ rejectUnauthorized: false });
    process.env.PGSSLMODE = 'disable';
    expect(getSslConfig()).toBe(false);
  });

  it('DB_SSL wins over PGSSLMODE', () => {
    process.env.DB_SSL = 'false';
    process.env.PGSSLMODE = 'require';
    expect(getSslConfig()).toBe(false);
  });

  it('DB_SSL_REJECT_UNAUTHORIZED=true tightens to full certificate verification', () => {
    process.env.NODE_ENV = 'production';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'true';
    expect(getSslConfig()).toEqual({ rejectUnauthorized: true });
  });

  it('an explicit option always wins over the env (both true and false)', () => {
    process.env.NODE_ENV = 'production';
    process.env.DB_SSL = 'true';
    // Explicit false forces plaintext despite prod + DB_SSL=true.
    expect(getSslConfig(false)).toBe(false);
    // Explicit object is passed through verbatim.
    expect(getSslConfig({ rejectUnauthorized: true })).toEqual({ rejectUnauthorized: true });
  });
});

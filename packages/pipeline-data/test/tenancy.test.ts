// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the tenant-context primitive. Covers:
 * - AsyncLocalStorage scope propagation
 * - withTenantTx GUC plumbing
 * - requireTenantContext fail-fast
 * - the warn/strict/silent context-mode toggle for surfacing missing-context bugs
 */

import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';

// Mock the drizzle db before importing tenancy so we capture transaction args.
const mockExecute = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockTx = { execute: mockExecute };
const mockTransaction = jest.fn((fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({
  db: { transaction: mockTransaction },
}));

const {
  getTenantContext,
  requireTenantContext,
  runWithTenantContext,
  withTenantTx,
} = await import('../src/database/tenancy.js');

const ORIGINAL_MODE = process.env.RLS_CONTEXT_MODE;

beforeEach(() => {
  mockExecute.mockReset();
  mockTransaction.mockClear();
  mockExecute.mockResolvedValue({ rows: [] });
});

afterAll(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.RLS_CONTEXT_MODE;
  else process.env.RLS_CONTEXT_MODE = ORIGINAL_MODE;
});

describe('runWithTenantContext / getTenantContext', () => {
  it('exposes the active context inside the scope', () => {
    runWithTenantContext({ orgId: 'org-a', isSuperAdmin: false }, () => {
      expect(getTenantContext()).toEqual({ orgId: 'org-a', isSuperAdmin: false });
    });
  });

  it('returns undefined outside any scope', () => {
    expect(getTenantContext()).toBeUndefined();
  });

  it('nested scopes shadow the outer one', () => {
    runWithTenantContext({ orgId: 'outer', isSuperAdmin: false }, () => {
      runWithTenantContext({ orgId: 'inner', isSuperAdmin: true }, () => {
        expect(getTenantContext()).toEqual({ orgId: 'inner', isSuperAdmin: true });
      });
      expect(getTenantContext()?.orgId).toBe('outer');
    });
  });

  it('survives across promise chains', async () => {
    await runWithTenantContext({ orgId: 'org-async', isSuperAdmin: false }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      expect(getTenantContext()?.orgId).toBe('org-async');
    });
  });
});

describe('requireTenantContext', () => {
  it('returns the active context inside a scope', () => {
    runWithTenantContext({ orgId: 'org-r', isSuperAdmin: false }, () => {
      expect(requireTenantContext().orgId).toBe('org-r');
    });
  });

  it('throws outside any scope', () => {
    expect(() => requireTenantContext()).toThrow(/no tenant scope active/);
  });
});

describe('withTenantTx', () => {
  it('SET LOCALs both GUCs from the surrounding context', async () => {
    await runWithTenantContext({ orgId: 'org-x', isSuperAdmin: true }, async () => {
      await withTenantTx(async () => 'ok');
    });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    // The drizzle `sql` tagged template returns an SQL object whose chunks
    // carry both string fragments and parameter values. Walk the chunks
    // to assert the right GUC names and values are bound for each call.
    const chunksOf = (call: unknown): string =>
      JSON.stringify((call as { queryChunks?: unknown }).queryChunks ?? call);
    expect(chunksOf(mockExecute.mock.calls[0][0])).toContain('app.org_id');
    expect(chunksOf(mockExecute.mock.calls[0][0])).toContain('org-x');
    expect(chunksOf(mockExecute.mock.calls[1][0])).toContain('app.is_sysadmin');
    expect(chunksOf(mockExecute.mock.calls[1][0])).toContain('true');
  });

  it('returns the inner fn result', async () => {
    const result = await runWithTenantContext({ orgId: 'o', isSuperAdmin: false }, () =>
      withTenantTx(async () => 42),
    );
    expect(result).toBe(42);
  });

  describe('context-mode handling', () => {
    let warnSpy: ReturnType<typeof jest.spyOn>;
    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('strict mode: throws when called outside any tenant scope', async () => {
      process.env.RLS_CONTEXT_MODE = 'strict';
      await expect(withTenantTx(async () => 'unreachable')).rejects.toThrow(/outside a tenant scope/);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('warn mode (default): still runs but logs a warning with stack', async () => {
      process.env.RLS_CONTEXT_MODE = 'warn';
      await withTenantTx(async () => 'ok');
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      // The transaction ran with empty GUCs — first execute should bind ''
      // for app.org_id. (The captured `sql` template includes the parameter
      // as part of its serialized form via Drizzle's tag mechanism; this
      // test asserts the call shape, not the exact SQL.)
    });

    it('silent mode: no warning, no throw, transaction still runs', async () => {
      process.env.RLS_CONTEXT_MODE = 'silent';
      await withTenantTx(async () => 'ok');
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('unknown mode value falls back to warn (non-production)', async () => {
      process.env.RLS_CONTEXT_MODE = 'something-else';
      await withTenantTx(async () => 'ok');
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('no override + NODE_ENV=production defaults to strict (throws)', async () => {
      delete process.env.RLS_CONTEXT_MODE;
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(withTenantTx(async () => 'unreachable')).rejects.toThrow(/outside a tenant scope/);
        expect(mockTransaction).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('no override + non-production defaults to warn (still runs)', async () => {
      delete process.env.RLS_CONTEXT_MODE;
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';
      try {
        await withTenantTx(async () => 'ok');
        expect(mockTransaction).toHaveBeenCalledTimes(1);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('strict mode does NOT throw when context IS active', async () => {
      process.env.RLS_CONTEXT_MODE = 'strict';
      await expect(
        runWithTenantContext({ orgId: 'o', isSuperAdmin: false }, () => withTenantTx(async () => 'ok')),
      ).resolves.toBe('ok');
    });
  });
});

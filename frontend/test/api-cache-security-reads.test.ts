// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two security reads that moved into the shared cache.
 *
 * The Security page asked for the TOTP status three times (the posture strip,
 * the authenticator panel, the recovery-code row) and the session list twice
 * (the posture strip and the sessions panel) — five requests for two answers.
 * What is pinned here is that one definition serves every reader, that a write
 * can drop it, and that a failed read THROWS rather than resolving to "off" /
 * "nothing signed in", which on a security surface would read as a fact.
 */

const getTotpStatus = jest.fn<AnyFn>();
const listSessions = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getTotpStatus: (...a: unknown[]) => getTotpStatus(...a),
    listSessions: (...a: unknown[]) => listSessions(...a),
  },
}));

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { invalidate, queries } from '../src/lib/api-cache';
import { clearQueryCache, runQuery } from '../src/lib/query-cache';

const TOTP = {
  enabled: true, pending: false, activatedAt: null, lastUsedAt: null,
  recoveryCodesRemaining: 8, recoveryCodesTotal: 10, recoveryGeneratedAt: null, lockedUntil: null,
};
const SESSIONS = { sessions: [{ id: 's1' }], machineSessions: [] };

beforeEach(() => {
  jest.clearAllMocks();
  clearQueryCache();
  getTotpStatus.mockResolvedValue({ success: true, data: { totp: TOTP } });
  listSessions.mockResolvedValue({ success: true, data: SESSIONS });
});

describe('queries.totpStatus', () => {
  it('serves every reader on the page from one request', async () => {
    const [a, b, c] = await Promise.all([
      runQuery(queries.totpStatus()),
      runQuery(queries.totpStatus()),
      runQuery(queries.totpStatus()),
    ]);
    expect(getTotpStatus).toHaveBeenCalledTimes(1);
    expect(a).toEqual(TOTP);
    expect([b, c]).toEqual([TOTP, TOTP]);
  });

  it('is re-read after a factor change drops it', async () => {
    await runQuery(queries.totpStatus());
    invalidate.totpStatus();
    await runQuery(queries.totpStatus());
    expect(getTotpStatus).toHaveBeenCalledTimes(2);
  });

  it('forwards the shared abort signal so a cancelled read leaves the wire', async () => {
    await runQuery(queries.totpStatus());
    expect(getTotpStatus).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('THROWS on a failed read rather than resolving to "two-factor is off"', async () => {
    getTotpStatus.mockResolvedValue({ success: false });
    await expect(runQuery(queries.totpStatus())).rejects.toThrow(/two-factor status/i);
  });
});

describe('queries.sessions', () => {
  it('serves the posture strip and the sessions panel from one request', async () => {
    const [a, b] = await Promise.all([runQuery(queries.sessions()), runQuery(queries.sessions())]);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(a).toEqual(SESSIONS);
    expect(b).toEqual(SESSIONS);
  });

  it('is re-read after a revoke drops it', async () => {
    await runQuery(queries.sessions());
    invalidate.sessions();
    await runQuery(queries.sessions());
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('THROWS on a failed read rather than resolving to "nothing is signed in"', async () => {
    listSessions.mockResolvedValue({ success: false });
    await expect(runQuery(queries.sessions())).rejects.toThrow(/sessions/i);
  });

  it('keeps the two keys apart', async () => {
    await Promise.all([runQuery(queries.totpStatus()), runQuery(queries.sessions())]);
    expect(getTotpStatus).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });
});

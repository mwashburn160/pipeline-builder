// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLI's device-authorization client (RFC 8628): the poll loop's handling of
 * the protocol's four error states.
 *
 * The loop is the part that can hang a terminal or hammer a platform, so what is
 * asserted is behavioural: it keeps waiting while the answer is
 * `authorization_pending`, BACKS OFF on `slow_down` (and keeps the wider
 * interval), stops immediately on the terminal errors, and gives up when the
 * code's own lifetime runs out.
 */

import type https from 'https';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockPost = jest.fn<(...a: unknown[]) => Promise<{ status: number; data: unknown }>>();

jest.unstable_mockModule('axios', () => ({
  __esModule: true,
  default: { post: mockPost },
}));

const { requestDeviceCode, pollForDeviceToken, DeviceAuthError } = await import('../src/utils/device-auth.js');

const transport = {
  url: 'https://platform.example.com',
  httpsAgent: {} as https.Agent,
  timeout: 30_000,
};

const CODE = {
  device_code: 'dev-code',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://platform.example.com/auth/device',
  verification_uri_complete: 'https://platform.example.com/auth/device?user_code=BCDF-GHJK',
  expires_in: 600,
  interval: 5,
};

/** The intervals the loop actually waited, in ms. */
let waits: number[] = [];
let clockOffset = 0;

beforeEach(() => {
  mockPost.mockReset();
  waits = [];
  clockOffset = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const realNow = Date.now;
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  // Timers are what make this loop slow, not what makes it correct: record the
  // requested delay, ADVANCE THE CLOCK by it (so the expiry deadline is reached
  // exactly as it would be in real time), and fire immediately.
  jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    clockOffset += ms ?? 0;
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
});

afterEach(() => { jest.restoreAllMocks(); });

/** An RFC error answer (HTTP 400 with `{ error }`). */
const pending = { status: 400, data: { error: 'authorization_pending' } };
const slowDown = (interval?: number) => ({ status: 400, data: { error: 'slow_down', ...(interval ? { interval } : {}) } });
const granted = {
  status: 200,
  data: { access_token: 'access.jwt', refresh_token: 'refresh.jwt', token_type: 'Bearer', expires_in: 900 },
};

describe('requestDeviceCode', () => {
  it('asks for a code and declares the CLI transport', async () => {
    mockPost.mockResolvedValue({ status: 200, data: CODE });

    await expect(requestDeviceCode(transport)).resolves.toEqual(CODE);

    const [url, body, cfg] = mockPost.mock.calls[0] as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(url).toBe('https://platform.example.com/api/auth/device/code');
    expect(body).toEqual({}); // no step-up requested
    expect(cfg.headers['X-Pb-Client']).toBe('cli');
  });

  it('asks for a step-up token when the caller needs one', async () => {
    mockPost.mockResolvedValue({ status: 200, data: CODE });
    await requestDeviceCode(transport, { stepUp: true });
    expect((mockPost.mock.calls[0] as [string, Record<string, unknown>])[1]).toEqual({ step_up: true });
  });

  it('refuses a response with no code rather than polling forever', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { user_code: 'BCDF-GHJK' } });
    await expect(requestDeviceCode(transport)).rejects.toThrow(DeviceAuthError);
  });
});

describe('pollForDeviceToken', () => {
  it('waits at the advertised interval and returns the session once approved', async () => {
    mockPost.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(granted);

    const session = await pollForDeviceToken(transport, CODE);

    expect(session.access_token).toBe('access.jwt');
    expect(session.refresh_token).toBe('refresh.jwt');
    expect(waits).toEqual([5_000, 5_000, 5_000]);
    // Every poll presents the device code and nothing else.
    expect((mockPost.mock.calls[0] as [string, Record<string, unknown>])[1]).toEqual({ device_code: 'dev-code' });
  });

  it('backs off on slow_down and keeps the wider interval', async () => {
    mockPost
      .mockResolvedValueOnce(slowDown())
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(granted);

    await pollForDeviceToken(transport, CODE);

    expect(waits).toEqual([5_000, 10_000, 10_000]);
  });

  it('honors an interval the platform names explicitly', async () => {
    mockPost.mockResolvedValueOnce(slowDown(30)).mockResolvedValueOnce(granted);

    await pollForDeviceToken(transport, CODE);

    expect(waits).toEqual([5_000, 30_000]);
  });

  it('stops immediately when the browser denies', async () => {
    mockPost.mockResolvedValue({ status: 400, data: { error: 'access_denied' } });

    await expect(pollForDeviceToken(transport, CODE)).rejects.toThrow(/denied in the browser/);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when the code has expired', async () => {
    mockPost.mockResolvedValue({ status: 400, data: { error: 'expired_token' } });

    await expect(pollForDeviceToken(transport, CODE)).rejects.toMatchObject({ code: 'expired_token' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unexpected protocol error instead of looping on it', async () => {
    mockPost.mockResolvedValue({ status: 400, data: { error: 'invalid_request', error_description: 'no device_code' } });

    await expect(pollForDeviceToken(transport, CODE)).rejects.toThrow('no device_code');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('gives up once the code\'s own lifetime has passed', async () => {
    // A 10s-lived code polled every 5s: two attempts, then the deadline.
    mockPost.mockResolvedValue(pending);

    await expect(pollForDeviceToken(transport, { ...CODE, expires_in: 10 }))
      .rejects.toThrow(/Timed out waiting/);
    expect(mockPost.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('refuses a 200 that carries no token', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { token_type: 'Bearer' } });

    await expect(pollForDeviceToken(transport, CODE)).rejects.toThrow(/returned no token/);
  });
});

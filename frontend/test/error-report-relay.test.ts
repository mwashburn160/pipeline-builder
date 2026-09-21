/**
 * @jest-environment node
 */
// (The relay runs in the Next.js server, not the browser.)
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side error-report relay: forwards a sanitized report to the runtime
 * `ERROR_REPORT_URL` collector, is a clean no-op when that env is unset, drops
 * non-reports, and caps throughput (the endpoint is unauthenticated).
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { createRelayLimiter, relayClientError, sanitizeReport } from '../src/lib/error-report-relay';

const okFetch = () => jest.fn<AnyFn>(async () => new Response(null, { status: 202 })) as unknown as jest.Mock<AnyFn> & typeof fetch;

describe('error-report relay', () => {
  it('is a no-op when no collector is configured', async () => {
    const fetchImpl = okFetch();
    await expect(relayClientError({ message: 'boom' }, { endpoint: undefined, allow: () => true, fetchImpl })).resolves.toBe('disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards only known fields, truncated, to the collector', async () => {
    const fetchImpl = okFetch();
    const outcome = await relayClientError(
      { message: 'x'.repeat(5_000), name: 'Error', cookie: 'secret', stack: 42 },
      { endpoint: 'https://collector.test/r', allow: () => true, fetchImpl },
    );
    expect(outcome).toBe('forwarded');
    const [url, init] = (fetchImpl as jest.Mock<AnyFn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://collector.test/r');
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(['message', 'name']);
    expect(body.message).toHaveLength(2_000);
  });

  it('drops a body that is not a report', async () => {
    const fetchImpl = okFetch();
    expect(sanitizeReport(['nope'])).toBeNull();
    await expect(relayClientError({ foo: 'bar' }, { endpoint: 'https://c.test', allow: () => true, fetchImpl })).resolves.toBe('invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws when the collector is down', async () => {
    const fetchImpl = jest.fn<AnyFn>(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(relayClientError({ message: 'boom' }, { endpoint: 'https://c.test', allow: () => true, fetchImpl })).resolves.toBe('failed');
  });

  it('caps reports per window, then recovers in the next window', () => {
    let t = 0;
    const allow = createRelayLimiter(2, 1_000, () => t);
    expect([allow(), allow(), allow()]).toEqual([true, true, false]);
    t = 1_000;
    expect(allow()).toBe(true);
  });
});

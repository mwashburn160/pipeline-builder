// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared cancellable-fetch core extracted from useFetch,
 * useEntityFetch, and useServerPagination. Locks the contract those three
 * hooks now delegate to: start → success/error → settled, with every
 * post-resolution write suppressed once cancelled.
 */

import { toError, runCancellableFetch } from '../src/hooks/internal/fetchCore';

describe('toError', () => {
  it('passes through Error instances unchanged', () => {
    const e = new Error('boom');
    expect(toError(e)).toBe(e);
  });

  it('wraps non-Error values with String()', () => {
    const e = toError('nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('nope');
  });
});

describe('runCancellableFetch', () => {
  it('runs onStart before the fetcher, then onSuccess + onSettled', async () => {
    const calls: string[] = [];
    runCancellableFetch(
      () => {
        calls.push('fetch');
        return Promise.resolve('data');
      },
      {
        onStart: () => calls.push('start'),
        onSuccess: (r) => calls.push(`success:${r}`),
        onError: () => calls.push('error'),
        onSettled: () => calls.push('settled'),
      },
    );
    // onStart is synchronous and must precede the fetcher invocation.
    expect(calls.slice(0, 2)).toEqual(['start', 'fetch']);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['start', 'fetch', 'success:data', 'settled']);
  });

  it('normalizes rejections to Error via onError', async () => {
    let received: Error | null = null;
    runCancellableFetch(() => Promise.reject('string-error'), {
      onStart: () => {},
      onSuccess: () => {},
      onError: (e) => { received = e; },
      onSettled: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toBeInstanceOf(Error);
    expect(received!.message).toBe('string-error');
  });

  it('suppresses all writes after the cleanup fn is invoked', async () => {
    const after: string[] = [];
    const cleanup = runCancellableFetch(() => Promise.resolve('data'), {
      onStart: () => {},
      onSuccess: () => after.push('success'),
      onError: () => after.push('error'),
      onSettled: () => after.push('settled'),
    });
    cleanup();
    await new Promise((r) => setTimeout(r, 0));
    expect(after).toEqual([]);
  });
});

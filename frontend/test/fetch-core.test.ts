// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared cancellable-fetch core extracted from useFetch,
 * useEntityFetch, and useServerPagination. Locks the contract those three
 * hooks now delegate to: start → success/error → settled, with every
 * post-resolution write suppressed once cancelled.
 */

import { waitFor } from '@testing-library/react';
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
    await waitFor(() => expect(calls).toEqual(['start', 'fetch', 'success:data', 'settled']));
  });

  it('normalizes rejections to Error via onError', async () => {
    let received: Error | null = null;
    runCancellableFetch(() => Promise.reject('string-error'), {
      onStart: () => {},
      onSuccess: () => {},
      onError: (e) => { received = e; },
      onSettled: () => {},
    });
    await waitFor(() => expect(received).toBeInstanceOf(Error));
    expect(received!.message).toBe('string-error');
  });

  it('suppresses all writes after the cleanup fn is invoked', async () => {
    const shared = Promise.resolve('data');
    const after: string[] = [];
    const cleanup = runCancellableFetch(() => shared, {
      onStart: () => {},
      onSuccess: () => after.push('success'),
      onError: () => after.push('error'),
      onSettled: () => after.push('settled'),
    });
    cleanup();
    // Sentinel: an uncancelled run on the SAME promise, registered after the
    // cancelled one. Promise reactions run FIFO, so once the sentinel has
    // settled every handler of the cancelled run has already had its turn —
    // no timer-based flush needed.
    const sentinel: string[] = [];
    runCancellableFetch(() => shared, {
      onStart: () => {},
      onSuccess: () => sentinel.push('success'),
      onError: () => sentinel.push('error'),
      onSettled: () => sentinel.push('settled'),
    });
    await waitFor(() => expect(sentinel).toEqual(['success', 'settled']));
    expect(after).toEqual([]);
  });
});

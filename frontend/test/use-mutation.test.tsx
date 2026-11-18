// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useMutation — the shared write core. Pins the five behaviours every write
 * flow used to hand-roll: the synchronous in-flight lock, scope/unmount
 * dropping, the step-up handoff, error formatting/toasts, and cache
 * invalidation (including tagged `useFetch` readers re-reading).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useMutation } from '../src/hooks/useMutation';
import { useFetch } from '../src/hooks/useFetch';
import { StepUpRequiredError } from '../src/lib/api/errors';
import { invalidate, queryTags } from '../src/lib/api-cache';
import { clearQueryCache, getTagEpoch, invalidateQueries } from '../src/lib/query-cache';

const toastSuccess = jest.fn<AnyFn>();
const toastError = jest.fn<AnyFn>();
let toastAvailable = true;
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => {
    if (!toastAvailable) throw new Error('useToast must be used within a ToastProvider');
    return { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) };
  },
}));

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A step-up refusal the global dialog has claimed, with a hand-settled replay. */
function claimedStepUp() {
  const err = new StepUpRequiredError('Step-up confirmation required', 'STEP_UP_REQUIRED');
  const replay = deferred<unknown>();
  replay.promise.catch(() => undefined);
  err.attachResume(replay.promise);
  return { err, replay };
}

beforeEach(() => {
  toastAvailable = true;
});

describe('useMutation — in-flight lock', () => {
  it('a second run while pending does not call fn again and returns the same promise', async () => {
    const d = deferred<string>();
    const fn = jest.fn<(x: number) => Promise<string>>().mockReturnValue(d.promise);
    const { result } = renderHook(() => useMutation({ fn }));

    let p1!: Promise<string | undefined>;
    let p2!: Promise<string | undefined>;
    act(() => {
      p1 = result.current.run(1);
      // Same tick — before any re-render could disable a button.
      p2 = result.current.run(2);
    });
    expect(p2).toBe(p1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
    expect(result.current.pending).toBe(true);

    await act(async () => { d.resolve('done'); await p1; });
    await expect(p1).resolves.toBe('done');
    expect(result.current.pending).toBe(false);

    // Released: the next run starts a new write.
    fn.mockResolvedValueOnce('again');
    let p3!: Promise<string | undefined>;
    await act(async () => { p3 = result.current.run(3); await p3; });
    await expect(p3).resolves.toBe('again');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even when fn throws synchronously', async () => {
    const fn = jest.fn<() => Promise<string>>()
      .mockImplementationOnce(() => { throw new Error('sync boom'); })
      .mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useMutation({ fn }));
    await act(async () => { await result.current.run(); });
    expect(result.current.error).toBe('sync boom');
    let out: string | undefined;
    await act(async () => { out = await result.current.run(); });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('useMutation — success / error', () => {
  it('runs onSuccess with result and args, toasts, and returns the result', async () => {
    const onSuccess = jest.fn<AnyFn>();
    const { result } = renderHook(() => useMutation({
      fn: async (a: number, b: number) => a + b,
      onSuccess,
      toast: { success: (r: number) => `sum ${r}` },
    }));
    let out: number | undefined;
    await act(async () => { out = await result.current.run(2, 3); });
    expect(out).toBe(5);
    expect(onSuccess).toHaveBeenCalledWith(5, 2, 3);
    expect(toastSuccess).toHaveBeenCalledWith('sum 5');
    expect(result.current.error).toBeNull();
  });

  it('formats the error, toasts it, calls onError, and resolves undefined (never rejects)', async () => {
    const onError = jest.fn<AnyFn>();
    const err = new Error('nope');
    const { result } = renderHook(() => useMutation({
      fn: async (_id: string) => { throw err; },
      onError,
      toast: { error: true },
    }));
    let out: unknown = 'unset';
    await act(async () => { out = await result.current.run('x'); });
    expect(out).toBeUndefined();
    expect(result.current.error).toBe('nope');
    expect(toastError).toHaveBeenCalledWith('nope');
    expect(onError).toHaveBeenCalledWith(err, 'nope', 'x');
  });

  it('uses errorFallback for a non-Error throw and a fixed error toast string', async () => {
    const { result } = renderHook(() => useMutation({
      fn: async () => { throw { weird: true }; },
      errorFallback: 'Failed to save',
      toast: { error: 'Could not save' },
    }));
    await act(async () => { await result.current.run(); });
    expect(result.current.error).toBe('Failed to save');
    expect(toastError).toHaveBeenCalledWith('Could not save');
  });

  it('reports a throw from onSuccess as the write error', async () => {
    const { result } = renderHook(() => useMutation({
      fn: async () => 1,
      onSuccess: () => { throw new Error('after-save failed'); },
    }));
    await act(async () => { await result.current.run(); });
    expect(result.current.error).toBe('after-save failed');
  });

  it('clears the previous error on the next run, and via reset / setError', async () => {
    const fn = jest.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce(2);
    const { result } = renderHook(() => useMutation({ fn }));
    await act(async () => { await result.current.run(); });
    expect(result.current.error).toBe('first');
    await act(async () => { await result.current.run(); });
    expect(result.current.error).toBeNull();
    act(() => result.current.setError('Name is required'));
    expect(result.current.error).toBe('Name is required');
    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });

  it('skips toasts silently when no ToastProvider is mounted', async () => {
    toastAvailable = false;
    const { result } = renderHook(() => useMutation({ fn: async () => 1, toast: { success: 'ok', error: true } }));
    let out: number | undefined;
    await act(async () => { out = await result.current.run(); });
    expect(out).toBe(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe('useMutation — scope and unmount', () => {
  it('drops the outcome when scopeKey changed before the write settled', async () => {
    const d = deferred<string>();
    const onSuccess = jest.fn<AnyFn>();
    const { result, rerender } = renderHook(({ scope }) => useMutation({
      fn: () => d.promise, scopeKey: scope, onSuccess, toast: { success: 'saved' },
    }), { initialProps: { scope: 'org-a' } });

    let p!: Promise<string | undefined>;
    act(() => { p = result.current.run(); });
    expect(result.current.pending).toBe(true);
    rerender({ scope: 'org-b' });
    // The new scope has nothing in flight.
    expect(result.current.pending).toBe(false);

    await act(async () => { d.resolve('late'); await p; });
    await expect(p).resolves.toBeUndefined();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('a scope change releases the lock for the new scope', async () => {
    const first = deferred<string>();
    const fn = jest.fn<() => Promise<string>>().mockReturnValueOnce(first.promise).mockResolvedValueOnce('b');
    const { result, rerender } = renderHook(({ scope }) => useMutation({ fn, scopeKey: scope }), { initialProps: { scope: 'a' } });
    act(() => { void result.current.run(); });
    rerender({ scope: 'b' });
    let out: string | undefined;
    await act(async () => { out = await result.current.run(); });
    expect(out).toBe('b');
    expect(fn).toHaveBeenCalledTimes(2);
    // The stale first write settling later must not flip the new scope's state.
    await act(async () => { first.resolve('a'); await first.promise; });
    expect(result.current.pending).toBe(false);
  });

  it('drops a failure from a previous scope rather than showing it in the next', async () => {
    const d = deferred<string>();
    const onError = jest.fn<AnyFn>();
    const { result, rerender } = renderHook(({ scope }) => useMutation({ fn: () => d.promise, scopeKey: scope, onError }), { initialProps: { scope: 1 } });
    let p!: Promise<string | undefined>;
    act(() => { p = result.current.run(); });
    rerender({ scope: 2 });
    await act(async () => { d.reject(new Error('stale')); await p; });
    expect(result.current.error).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('scopes an error to the scope it happened in', async () => {
    const { result, rerender } = renderHook(({ scope }) => useMutation({
      fn: async () => { throw new Error('bad'); }, scopeKey: scope,
    }), { initialProps: { scope: 'x' } });
    await act(async () => { await result.current.run(); });
    expect(result.current.error).toBe('bad');
    rerender({ scope: 'y' });
    expect(result.current.error).toBeNull();
    rerender({ scope: 'x' });
    expect(result.current.error).toBe('bad');
  });

  it('drops callbacks and state writes after unmount', async () => {
    const d = deferred<string>();
    const onSuccess = jest.fn<AnyFn>();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useMutation({ fn: () => d.promise, onSuccess }));
    let p!: Promise<string | undefined>;
    act(() => { p = result.current.run(); });
    unmount();
    d.resolve('late');
    await expect(p).resolves.toBeUndefined();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('useMutation — step-up handoff', () => {
  it('is not an error: pending clears, no error, resolves undefined; onStepUpResumed + invalidation on replay', async () => {
    const { err, replay } = claimedStepUp();
    const onError = jest.fn<AnyFn>();
    const onStepUpResumed = jest.fn<AnyFn>();
    const spy = jest.spyOn(invalidate, 'pipelines');
    const { result } = renderHook(() => useMutation({
      fn: async (_id: string) => { throw err; },
      onError,
      onStepUpResumed,
      invalidates: ['pipelines'],
      toast: { error: true },
    }));
    let out: unknown = 'unset';
    await act(async () => { out = await result.current.run('p1'); });
    expect(out).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();

    await act(async () => { replay.resolve({ success: true }); await replay.promise; });
    await waitFor(() => expect(onStepUpResumed).toHaveBeenCalledWith({ success: true }, 'p1'));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('calls onStepUpAbandoned when the dialog is dismissed', async () => {
    const { err, replay } = claimedStepUp();
    const onStepUpAbandoned = jest.fn<AnyFn>();
    const { result } = renderHook(() => useMutation({ fn: async () => { throw err; }, onStepUpAbandoned }));
    await act(async () => { await result.current.run(); });
    await act(async () => { replay.reject(err); await replay.promise.catch(() => undefined); });
    await waitFor(() => expect(onStepUpAbandoned).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
  });

  it('an UNCLAIMED step-up refusal (no global dialog) is an ordinary error', async () => {
    const err = new StepUpRequiredError('Confirm your identity', 'STEP_UP_REQUIRED');
    const { result } = renderHook(() => useMutation({ fn: async () => { throw err; } }));
    await act(async () => { await result.current.run(); });
    expect(result.current.error).toBe('Confirm your identity');
  });
});

describe('useMutation — invalidation', () => {
  it('invalidates the named caches after success (even when the outcome is dropped), never after failure', async () => {
    const pipelines = jest.spyOn(invalidate, 'pipelines');
    const members = jest.spyOn(invalidate, 'orgMembers');
    const ok = renderHook(() => useMutation({ fn: async () => 1, invalidates: ['pipelines', 'orgMembers'] }));
    await act(async () => { await ok.result.current.run(); });
    expect(pipelines).toHaveBeenCalledTimes(1);
    expect(members).toHaveBeenCalledTimes(1);

    const bad = renderHook(() => useMutation({ fn: async () => { throw new Error('x'); }, invalidates: ['pipelines'] }));
    await act(async () => { await bad.result.current.run(); });
    expect(pipelines).toHaveBeenCalledTimes(1);

    const d = deferred<number>();
    const gone = renderHook(() => useMutation({ fn: () => d.promise, invalidates: ['pipelines'] }));
    let p!: Promise<number | undefined>;
    act(() => { p = gone.result.current.run(); });
    gone.unmount();
    d.resolve(1);
    await p;
    // The write happened, so the cache is still wrong — invalidate regardless.
    expect(pipelines).toHaveBeenCalledTimes(2);
    pipelines.mockRestore();
    members.mockRestore();
  });

  it('a tagged useFetch reader re-reads after the mutation invalidates its tag', async () => {
    const fetcher = jest.fn<AnyFn>().mockResolvedValueOnce(['a']).mockResolvedValueOnce(['a', 'b']);
    const reader = renderHook(() => useFetch(fetcher, [], { tags: [queryTags.pipelines] }));
    await waitFor(() => expect(reader.result.current.data).toEqual(['a']));

    const m = renderHook(() => useMutation({ fn: async () => true, invalidates: ['pipelines'] }));
    await act(async () => { await m.result.current.run(); });
    await waitFor(() => expect(reader.result.current.data).toEqual(['a', 'b']));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('an untagged / differently-tagged reader is left alone', async () => {
    const plain = jest.fn<AnyFn>().mockResolvedValue(1);
    const plugins = jest.fn<AnyFn>().mockResolvedValue(2);
    const r1 = renderHook(() => useFetch(plain, []));
    const r2 = renderHook(() => useFetch(plugins, [], { tags: [queryTags.plugins] }));
    await waitFor(() => expect(r1.result.current.data).toBe(1));
    await waitFor(() => expect(r2.result.current.data).toBe(2));
    act(() => invalidate.pipelines());
    await act(async () => { await Promise.resolve(); });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(plugins).toHaveBeenCalledTimes(1);
  });
});

describe('getTagEpoch', () => {
  it('matches broader and narrower prefixes, and wakes everything on a full invalidation / clear', () => {
    const all = queryTags.orgMembers();
    const one = queryTags.orgMembers('o1');
    const other = queryTags.orgMembers('o2');
    const base = { all: getTagEpoch(all), one: getTagEpoch(one), other: getTagEpoch(other) };
    invalidate.orgMembers('o1');
    expect(getTagEpoch(all)).toBe(base.all + 1);
    expect(getTagEpoch(one)).toBe(base.one + 1);
    expect(getTagEpoch(other)).toBe(base.other);
    invalidate.orgMembers();
    expect(getTagEpoch(other)).toBe(base.other + 1);
    const plugins = getTagEpoch(queryTags.plugins);
    invalidateQueries();
    expect(getTagEpoch(queryTags.plugins)).toBe(plugins + 1);
    clearQueryCache();
    expect(getTagEpoch(queryTags.plugins)).toBe(plugins + 2);
  });
});


// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useCrudResource.fetch` must let only the LATEST request publish. RuleList and
 * PolicyManager refetch on every filter, sort and page change, and nothing
 * ordered the responses: picking "critical" then "warning" quickly could leave
 * the critical rules — with their total and pagination — on screen under the
 * "warning" filter.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook } from '@testing-library/react';
import { useCrudResource } from '../src/hooks/useCrudResource';

type Item = { id: string };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useCrudResource.fetch', () => {
  it('ignores a slower, OLDER response that lands after a newer one', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    const list = jest.fn<AnyFn>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const api = { list, create: jest.fn<AnyFn>(), update: jest.fn<AnyFn>(), remove: jest.fn<AnyFn>() } as never;

    const { result } = renderHook(() => useCrudResource<Item, never, never, never>(api, 'rule'));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.fetch({ severity: 'critical' } as never); });
    act(() => { second = result.current.fetch({ severity: 'warning' } as never); });

    await act(async () => {
      newer.resolve({ success: true, data: { items: [{ id: 'warning-1' }], pagination: { total: 1 } } });
      await second;
    });
    await act(async () => {
      older.resolve({ success: true, data: { items: [{ id: 'critical-1' }, { id: 'critical-2' }], pagination: { total: 2 } } });
      await first;
    });

    expect(result.current.items.map((i) => i.id)).toEqual(['warning-1']);
    expect(result.current.total).toBe(1);
    expect(result.current.loading).toBe(false);
  });
});

describe('useCrudResource total', () => {
  it('follows a create and a delete, so the count beside the list is not stale', async () => {
    const api = {
      list: jest.fn<AnyFn>(async () => ({ success: true, data: { items: [{ id: 'a' }, { id: 'b' }], pagination: { total: 2 } } })),
      create: jest.fn<AnyFn>(async () => ({ success: true, data: { item: { id: 'c' } } })),
      update: jest.fn<AnyFn>(),
      delete: jest.fn<AnyFn>(async () => ({ success: true })),
    } as never;
    const { result } = renderHook(() => useCrudResource<Item, never, never, never>(api, 'policy'));

    await act(async () => { await result.current.fetch(); });
    expect(result.current.total).toBe(2);

    await act(async () => { await result.current.create({} as never); });
    expect(result.current.total).toBe(3);

    await act(async () => { await result.current.remove('a'); });
    expect(result.current.items.map((i) => i.id)).toEqual(['c', 'b']);
    expect(result.current.total).toBe(2);
  });
});

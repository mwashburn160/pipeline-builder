// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared "latest value" hooks that replaced the `exhaustive-deps`
 * suppressions (see test/exhaustive-deps-suppressions.test.ts).
 *
 *  - `useLatest` — a ref holding the newest committed value;
 *  - `useEventCallback` — a stable function that runs the newest closure;
 *  - `useKeyedValue` — a rebuilt-per-render object, held while its key is unchanged;
 *  - `useStableDeps` — a caller's dep list as one value, new only when an element changes.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { useEffect, useMemo } from 'react';
import { fireEvent, render, renderHook } from '@testing-library/react';
import { useEventCallback, useKeyedValue, useLatest, useStableDeps } from '../src/hooks/useLatest';

describe('useLatest', () => {
  it('holds the value of the latest committed render', () => {
    const { result, rerender } = renderHook(({ v }) => useLatest(v), { initialProps: { v: 1 } });
    const ref = result.current;
    expect(ref.current).toBe(1);
    rerender({ v: 2 });
    expect(result.current).toBe(ref); // same ref object across renders
    expect(ref.current).toBe(2);
  });

  it('is already current when a passive effect of the same commit reads it', () => {
    const seen: number[] = [];
    function Probe({ v }: { v: number }) {
      const latest = useLatest(v);
      useEffect(() => { seen.push(latest.current); });
      return null;
    }
    const { rerender } = render(<Probe v={1} />);
    rerender(<Probe v={2} />);
    expect(seen).toEqual([1, 2]);
  });
});

describe('useEventCallback', () => {
  it('keeps one identity across renders', () => {
    const { result, rerender } = renderHook(({ n }) => useEventCallback(() => n), { initialProps: { n: 1 } });
    const first = result.current;
    rerender({ n: 2 });
    rerender({ n: 3 });
    expect(result.current).toBe(first);
  });

  it('calls the closure of the latest render, with its arguments and return value', () => {
    const { result, rerender } = renderHook(({ n }) => useEventCallback((x: number) => x + n), { initialProps: { n: 1 } });
    const stable = result.current;
    expect(stable(10)).toBe(11);
    rerender({ n: 5 });
    expect(stable(10)).toBe(15);
  });

  it('a memo that depends on it is not rebuilt, yet never runs a stale closure', () => {
    const calls: string[] = [];
    let builds = 0;
    function Table({ label }: { label: string }) {
      const onRow = useEventCallback(() => { calls.push(label); });
      // A memoised column builder, as the dashboard tables use.
      const columns = useMemo(() => { builds++; return [{ onClick: onRow }]; }, [onRow]);
      return <button type="button" onClick={columns[0].onClick}>row</button>;
    }
    const { rerender, getByRole } = render(<Table label="a" />);
    rerender(<Table label="b" />);
    fireEvent.click(getByRole('button'));
    expect(calls).toEqual(['b']);
    expect(builds).toBe(1);
  });
});

describe('useKeyedValue', () => {
  it('returns the first object seen for a key, and the new one when the key changes', () => {
    const a1 = { q: 'a' };
    const a2 = { q: 'a' };
    const b = { q: 'b' };
    const { result, rerender } = renderHook(({ v }) => useKeyedValue(v, JSON.stringify(v)), { initialProps: { v: a1 } });
    expect(result.current).toBe(a1);
    rerender({ v: a2 });
    expect(result.current).toBe(a1); // same key → identity held
    rerender({ v: b });
    expect(result.current).toBe(b);
    rerender({ v: { q: 'b' } });
    expect(result.current).toBe(b);
  });

  it('re-runs a dependent effect only when the key changes', () => {
    const effect = jest.fn();
    function Probe({ v }: { v: { q: string } }) {
      const held = useKeyedValue(v, v.q);
      useEffect(() => { effect(held.q); }, [held]);
      return null;
    }
    const { rerender } = render(<Probe v={{ q: 'a' }} />);
    rerender(<Probe v={{ q: 'a' }} />);
    rerender(<Probe v={{ q: 'a' }} />);
    rerender(<Probe v={{ q: 'b' }} />);
    expect(effect.mock.calls).toEqual([['a'], ['b']]);
  });
});

describe('useStableDeps', () => {
  it('returns the same array while every element is Object.is-equal', () => {
    const fn = () => {};
    const { result, rerender } = renderHook(({ d }) => useStableDeps(d), { initialProps: { d: [1, 'x', fn] as unknown[] } });
    const first = result.current;
    rerender({ d: [1, 'x', fn] });
    expect(result.current).toBe(first);
    rerender({ d: [1, 'y', fn] });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual([1, 'y', fn]);
  });

  it('treats a length change as a change (no React "deps changed size" error)', () => {
    const { result, rerender } = renderHook(({ d }) => useStableDeps(d), { initialProps: { d: [1] as unknown[] } });
    const first = result.current;
    rerender({ d: [1, 2] });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual([1, 2]);
  });

  it('compares with Object.is (NaN equals NaN; a new object is a change)', () => {
    const { result, rerender } = renderHook(({ d }) => useStableDeps(d), { initialProps: { d: [NaN, {}] as unknown[] } });
    const first = result.current;
    rerender({ d: [NaN, first[1]] });
    expect(result.current).toBe(first);
    rerender({ d: [NaN, {}] });
    expect(result.current).not.toBe(first);
  });
});

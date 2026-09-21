// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard grid width must follow an element that mounts LATE. The pages
 * render a loading state first; a mount-only effect found no element, never
 * ran again, and every dashboard stayed at the 960px default.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { act, render } from '@testing-library/react';
import { useElementWidth } from '../src/hooks/useElementWidth';

let observed: Array<() => void> = [];
class FakeResizeObserver {
  constructor(private cb: () => void) { observed.push(cb); }
  observe() {}
  disconnect() { observed = observed.filter((c) => c !== this.cb); }
}

beforeEach(() => {
  observed = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});

function Grid({ loaded }: { loaded: boolean }) {
  const [ref, width] = useElementWidth(960);
  return (
    <>
      <span data-testid="width">{width}</span>
      {loaded ? <div ref={ref} data-testid="grid" /> : <p>loading</p>}
    </>
  );
}

function setClientWidth(el: Element, w: number) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: w });
}

describe('useElementWidth', () => {
  it('measures an element that mounts AFTER the first render, and follows resizes', () => {
    // Stub the prototype so the grid reports a width the moment it mounts.
    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
    try {
      const { rerender, getByTestId } = render(<Grid loaded={false} />);
      expect(getByTestId('width').textContent).toBe('960');

      rerender(<Grid loaded />);
      expect(getByTestId('width').textContent).toBe('1400');

      setClientWidth(getByTestId('grid'), 700);
      act(() => { observed.forEach((cb) => cb()); });
      expect(getByTestId('width').textContent).toBe('700');
    } finally {
      if (proto) Object.defineProperty(HTMLElement.prototype, 'clientWidth', proto);
    }
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Screen-reader + reduced-motion behaviour.
 *
 * Loading states must not be silent (a bare decorative <svg>), and
 * `prefers-reduced-motion` must reach framer-motion drawers/toasts and CSS
 * keyframes alike. framer is handled app-wide by
 * <MotionConfig reducedMotion="user"> and CSS by a media block; scripted
 * smooth-scrolling needs the helper tested here.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
import { LoadingSpinner } from '../src/components/ui/Loading';
import { prefersReducedMotion, scrollBehavior } from '../src/lib/motion';

/** Stub matchMedia so the reduce-motion query resolves either way. */
function mockReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: jest.fn<AnyFn>(),
      removeEventListener: jest.fn<AnyFn>(),
    }),
  });
}

describe('LoadingSpinner', () => {
  it('announces what is loading', () => {
    render(<LoadingSpinner label="Loading builds" />);
    expect(screen.getByRole('status', { name: 'Loading builds' })).toBeInTheDocument();
  });

  it('defaults to a generic announcement rather than silence', () => {
    render(<LoadingSpinner />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('stays silent when an ancestor already announces the state', () => {
    // e.g. inside a "Deleting…" button or a role="status" progress block —
    // otherwise the same thing is announced twice.
    const { container } = render(<LoadingSpinner label={null} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('reduced motion', () => {
  afterEach(() => mockReducedMotion(false));

  it('detects the user preference', () => {
    mockReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    mockReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('jumps instead of smooth-scrolling when motion is reduced', () => {
    mockReducedMotion(true);
    expect(scrollBehavior()).toBe('auto');
    mockReducedMotion(false);
    expect(scrollBehavior()).toBe('smooth');
  });

  it('is SSR-safe (no window.matchMedia)', () => {
    const original = window.matchMedia;
    // @ts-expect-error — deliberately removing it to mimic the server render.
    delete window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe('smooth');
    window.matchMedia = original;
  });
});

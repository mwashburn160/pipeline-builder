// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reusable ErrorBoundary (src/components/ErrorBoundary.tsx).
 *
 * Its card is an ALERT — `role="alert"`, so a screen reader announces the
 * failure where it happened — with a real, focusable Retry button that
 * remounts the subtree. Every catch is reported twice: the full error to the
 * client-error relay (unchanged), and a bounded `{boundary, route}` count to
 * the observability stack through the telemetry module, where `route` is the
 * route PATTERN from the nearest <ErrorBoundaryRoute> (the dashboard layout
 * provides it) or an explicit prop.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';

const reportBoundaryError = jest.fn<AnyFn>();
jest.mock('@/lib/telemetry/web-vitals', () => ({ reportBoundaryError: (...a: unknown[]) => reportBoundaryError(...a) }));
const reportClientError = jest.fn<AnyFn>();
jest.mock('@/lib/error-reporter', () => ({ reportClientError: (...a: unknown[]) => reportClientError(...a) }));

import { ErrorBoundary, ErrorBoundaryRoute } from '../src/components/ErrorBoundary';

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error('kaboom at /dashboard/pipelines/0f3c9a');
  return <p>recovered</p>;
}

beforeEach(() => {
  shouldThrow = true;
  reportBoundaryError.mockClear();
  reportClientError.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ErrorBoundary', () => {
  it('renders an accessible alert card with a focusable Retry button', () => {
    render(<ErrorBoundary boundary="page" route="/dashboard"><Bomb /></ErrorBoundary>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    expect(retry).toHaveFocus();
    expect(alert).toContainElement(retry);
  });

  it('Retry remounts the subtree', () => {
    render(<ErrorBoundary boundary="page" route="/dashboard"><Bomb /></ErrorBoundary>);
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('counts the catch by boundary and route pattern, and still sends the full error to the relay', () => {
    render(<ErrorBoundary boundary="chart" route="/dashboard/logs"><Bomb /></ErrorBoundary>);
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
    expect(reportBoundaryError).toHaveBeenCalledWith('chart', '/dashboard/logs');
    expect(reportClientError).toHaveBeenCalledTimes(1);
  });

  it('takes the route pattern from the nearest ErrorBoundaryRoute', () => {
    render(
      <ErrorBoundaryRoute route="/dashboard/pipelines/[id]">
        <ErrorBoundary boundary="ask-panel"><Bomb /></ErrorBoundary>
      </ErrorBoundaryRoute>,
    );
    expect(reportBoundaryError).toHaveBeenCalledWith('ask-panel', '/dashboard/pipelines/[id]');
  });

  it('a compact boundary (charts) keeps its card small and names what failed', () => {
    render(<ErrorBoundary boundary="chart" route="/dashboard/logs" compact label="Log volume"><Bomb /></ErrorBoundary>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Log volume');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('clears itself when resetKey changes (navigation within a dynamic route)', () => {
    const { rerender } = render(<ErrorBoundary boundary="page" route="/x" resetKey="/x/1"><Bomb /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    shouldThrow = false;
    rerender(<ErrorBoundary boundary="page" route="/x" resetKey="/x/2"><Bomb /></ErrorBoundary>);
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('renders a custom fallback when given one', () => {
    render(<ErrorBoundary boundary="page" route="/x" fallback={<p>custom</p>}><Bomb /></ErrorBoundary>);
    expect(screen.getByText('custom')).toBeInTheDocument();
  });
});

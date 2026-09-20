// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Toast stack behaviour: severity-based durations, dedupe of identical
 * messages, the visible cap, and lifting above the BulkActionBar.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../src/components/ui/Toast';
import { BulkActionBar } from '../src/components/dashboard/BulkActionBar';
import { TOAST_OFFSET_CSS_VAR } from '../src/lib/constants';

jest.mock('framer-motion', () => {
  const React = jest.requireActual('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    motion: new Proxy({}, {
      get: (_t, tag: string) => ({ children, initial: _i, animate: _a, exit: _e, transition: _tr, ...rest }: Record<string, unknown>) =>
        React.createElement(tag, rest, children),
    }),
  };
});

let fire: ReturnType<typeof useToast>;
function Harness() {
  fire = useToast();
  return null;
}

function renderStack() {
  return render(<ToastProvider><Harness /></ToastProvider>);
}

describe('Toast stack', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps errors for 8s but success for 4s', () => {
    renderStack();
    act(() => { fire.success('saved'); fire.error('broke'); });
    act(() => { jest.advanceTimersByTime(4100); });
    expect(screen.queryByText('saved')).not.toBeInTheDocument();
    expect(screen.getByText('broke')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(4000); });
    expect(screen.queryByText('broke')).not.toBeInTheDocument();
  });

  it('dismisses an error early when the close button is used', () => {
    renderStack();
    act(() => { fire.error('broke'); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('broke')).not.toBeInTheDocument();
  });

  it('dedupes an identical message into one toast with a count, restarting its timer', () => {
    renderStack();
    act(() => { fire.error('broke'); });
    act(() => { jest.advanceTimersByTime(6000); });
    act(() => { fire.error('broke'); });
    expect(screen.getAllByText('broke')).toHaveLength(1);
    expect(screen.getByLabelText('repeated 2 times')).toBeInTheDocument();
    // The repeat restarted the 8s window.
    act(() => { jest.advanceTimersByTime(6000); });
    expect(screen.getByText('broke')).toBeInTheDocument();
  });

  it('does not merge the same text across severities', () => {
    renderStack();
    act(() => { fire.info('x'); fire.error('x'); });
    expect(screen.getAllByText('x')).toHaveLength(2);
  });

  it('shows at most 3 toasts and collapses older ones', () => {
    renderStack();
    act(() => { ['a', 'b', 'c', 'd', 'e'].forEach((m) => fire.info(m)); });
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    ['c', 'd', 'e'].forEach((m) => expect(screen.getByText(m)).toBeInTheDocument());
    expect(screen.getByText('+2 more')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss older' }));
    expect(screen.queryByText('+2 more')).not.toBeInTheDocument();
    ['c', 'd', 'e'].forEach((m) => expect(screen.getByText(m)).toBeInTheDocument());
  });

  it('does not resurrect a toast dismissed in the same tick', () => {
    // The dismiss and the new toast are batched into one render. `addToast`
    // reads the stack synchronously, so a ref that only `addToast` wrote back
    // re-committed the list as it was BEFORE the dismiss.
    renderStack();
    act(() => { fire.error('gone'); });
    const dismiss = screen.getByRole('button', { name: 'Dismiss notification' });
    act(() => { fireEvent.click(dismiss); fire.success('fresh'); });
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
    expect(screen.getByText('fresh')).toBeInTheDocument();
  });

  it('does not resurrect the collapsed toasts dismissed in the same tick', () => {
    renderStack();
    act(() => { ['a', 'b', 'c', 'd', 'e'].forEach((m) => fire.info(m)); });
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss older' })); fire.info('f'); });
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.queryByText('b')).not.toBeInTheDocument();
    expect(screen.queryByText('+2 more')).not.toBeInTheDocument();
    expect(screen.getByText('f')).toBeInTheDocument();
  });

  it('positions the stack from the toast-offset CSS variable', () => {
    renderStack();
    expect(screen.getByTestId('toast-stack').style.bottom).toBe(`calc(1rem + var(${TOAST_OFFSET_CSS_VAR}, 0px))`);
  });
});

describe('BulkActionBar raises the toast stack', () => {
  const noop = () => undefined;

  it('publishes its height while visible and clears it when hidden', () => {
    const root = document.documentElement;
    const { rerender } = render(<BulkActionBar count={2} busy={false} onActivate={noop} onDelete={noop} onClear={noop} />);
    // jsdom has no layout, so the fallback height is published.
    expect(root.style.getPropertyValue(TOAST_OFFSET_CSS_VAR)).toBe('4rem');
    rerender(<BulkActionBar count={0} busy={false} onActivate={noop} onDelete={noop} onClear={noop} />);
    expect(root.style.getPropertyValue(TOAST_OFFSET_CSS_VAR)).toBe('');
  });
});

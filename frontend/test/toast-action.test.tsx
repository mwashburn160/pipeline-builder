// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Toast inline action (e.g. "Undo"): a one-shot button that runs its callback
 * AND dismisses the toast, so the same undo can't be fired twice.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../src/components/ui/Toast';

function Harness({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.success('Removed 2 messages', undefined, { label: 'Undo', onClick: onUndo })}>fire</button>
      <button onClick={() => toast.success('plain')}>fire-plain</button>
    </div>
  );
}

describe('Toast action', () => {
  it('renders the action, runs it once, and dismisses the toast', () => {
    const onUndo = jest.fn();
    render(<ToastProvider><Harness onUndo={onUndo} /></ToastProvider>);

    fireEvent.click(screen.getByText('fire'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Removed 2 messages')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('a toast without an action renders no action button', () => {
    render(<ToastProvider><Harness onUndo={() => {}} /></ToastProvider>);
    fireEvent.click(screen.getByText('fire-plain'));
    expect(screen.getByText('plain')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "N selected" strip and the bulk-outcome summary were duplicated on the
 * users and invitations pages, identical apart from the noun and the verb.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { BulkSelectionBanner, BulkResultSummary } from '../src/components/dashboard/BulkSelectionBanner';

describe('BulkSelectionBanner', () => {
  it('renders nothing with no selection', () => {
    const { container } = render(
      <BulkSelectionBanner count={0} noun="user" actionLabel="Delete" onClear={() => {}} onAction={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('pluralises the noun and labels the destructive action with the count', () => {
    const { rerender } = render(
      <BulkSelectionBanner count={1} noun="invitation" actionLabel="Revoke" onClear={() => {}} onAction={() => {}} />,
    );
    expect(screen.getByText(/invitation selected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke 1' })).toBeInTheDocument();

    rerender(<BulkSelectionBanner count={3} noun="invitation" actionLabel="Revoke" onClear={() => {}} onAction={() => {}} />);
    expect(screen.getByText(/invitations selected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke 3' })).toBeInTheDocument();
  });

  it('wires clear and the destructive action separately', () => {
    const onClear = jest.fn();
    const onAction = jest.fn();
    render(<BulkSelectionBanner count={2} noun="user" actionLabel="Delete" onClear={onClear} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('BulkResultSummary', () => {
  it('reads as success when nothing failed and as a warning otherwise', () => {
    const { container, rerender } = render(
      <BulkResultSummary failed={0} errors={[]}>done</BulkResultSummary>,
    );
    expect(container.firstElementChild!.className).toContain('bg-success-bg');

    rerender(<BulkResultSummary failed={2} errors={[]}>done</BulkResultSummary>);
    expect(container.firstElementChild!.className).toContain('bg-warning-bg');
  });

  it('lists the per-row failures it was given', () => {
    render(<BulkResultSummary failed={2} errors={['u1: nope', 'u2: nope']}>done</BulkResultSummary>);
    expect(screen.getByText('u1: nope')).toBeInTheDocument();
    expect(screen.getByText('u2: nope')).toBeInTheDocument();
  });

  it('offers Dismiss only when the caller can clear it', () => {
    const onDismiss = jest.fn();
    const { rerender } = render(<BulkResultSummary failed={0} errors={[]}>done</BulkResultSummary>);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    rerender(<BulkResultSummary failed={0} errors={[]} onDismiss={onDismiss}>done</BulkResultSummary>);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

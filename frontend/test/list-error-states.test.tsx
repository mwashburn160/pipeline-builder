// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A failed load must never render as an empty list.
 *
 * `useListPage` reports the failure in `error` but leaves `data` empty, so every
 * list page used to show "Failed to load…" AND "No users yet — Create user" at
 * once; people read the empty state and believed the org was empty. DataTable now
 * takes `loadFailed` and offers a retry instead, and the alert banners carry a
 * Retry action so a dead-end error can be recovered without a page reload.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { Users } from 'lucide-react';
import { DataTable, type Column } from '../src/components/ui/DataTable';
import { ErrorAlert } from '../src/components/ui/ErrorAlert';
import { InfoAlert } from '../src/components/ui/InfoAlert';

interface Row { id: string; name: string }
const columns: Column<Row>[] = [{ id: 'name', header: 'Name', render: (r) => r.name }];
const emptyState = { icon: Users, title: 'No users yet', description: 'Create your first user.' };

const renderTable = (props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) =>
  render(
    <DataTable
      data={[]}
      columns={columns}
      isLoading={false}
      emptyState={emptyState}
      getRowKey={(r) => r.id}
      {...props}
    />,
  );

describe('DataTable — failed load vs empty list', () => {
  it('shows the empty state when the list is genuinely empty', () => {
    renderTable();
    expect(screen.getByText('No users yet')).toBeInTheDocument();
  });

  it('never claims "nothing here" when the load failed', () => {
    renderTable({ loadFailed: true, onRetry: jest.fn() });
    expect(screen.queryByText('No users yet')).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't load this list/i)).toBeInTheDocument();
  });

  it('offers a retry that re-runs the fetch', () => {
    const onRetry = jest.fn();
    renderTable({ loadFailed: true, onRetry });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('still reports the failure when no retry handler is wired', () => {
    renderTable({ loadFailed: true });
    expect(screen.getByText(/couldn't load this list/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('keeps rows already loaded when a REFRESH fails (no blank table)', () => {
    renderTable({ data: [{ id: '1', name: 'ada' }], loadFailed: true, onRetry: jest.fn() });
    expect(screen.getByText('ada')).toBeInTheDocument();
    expect(screen.queryByText(/couldn't load this list/i)).not.toBeInTheDocument();
  });

  it('shows the loading skeleton rather than an error while in flight', () => {
    renderTable({ isLoading: true, loadFailed: true, onRetry: jest.fn() });
    expect(screen.queryByText(/couldn't load this list/i)).not.toBeInTheDocument();
  });
});

describe('alert banners', () => {
  it('ErrorAlert offers Retry alongside Dismiss', () => {
    const onRetry = jest.fn();
    const onDismiss = jest.fn();
    render(<ErrorAlert message="Failed to load data" onRetry={onRetry} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ErrorAlert stays dismiss-only when no retry is given', () => {
    render(<ErrorAlert message="boom" onDismiss={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('announces info banners with a real ARIA role (role="note" is inert)', () => {
    render(<InfoAlert message="Heads up" />);
    expect(screen.getByRole('status')).toHaveTextContent('Heads up');
  });
});

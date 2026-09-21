// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Accessibility of overlays, tables and charts.
 *
 *  - `useDialogBehavior` is the shared overlay contract (Tab trap, Escape,
 *    focus-in/restore, scroll lock). The log-details drawer had every part
 *    EXCEPT the trap, so focus walked into the table behind it.
 *  - Column headers need `scope="col"` to be announced as headers.
 *  - Chart series carry a dash pattern as well as a colour, so they stay
 *    distinguishable without colour vision.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { useRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Users } from 'lucide-react';
import { useDialogBehavior } from '../src/hooks/useDialogBehavior';
import { DataTable, type Column } from '../src/components/ui/DataTable';
import { prepareSeries, SERIES_DASHES } from '../src/components/observability/_chartUtils';

function Overlay({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogBehavior({ panelRef, onClose });
  return (
    <div>
      <button>outside</button>
      <div ref={panelRef} role="dialog">
        <button>first</button>
        <button>last</button>
      </div>
    </div>
  );
}

describe('useDialogBehavior', () => {
  it('moves focus into the panel on open', () => {
    render(<Overlay onClose={jest.fn<AnyFn>()} />);
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('locks background scroll while open and restores it after', () => {
    const { unmount } = render(<Overlay onClose={jest.fn<AnyFn>()} />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('wraps Tab at the end of the panel instead of escaping to the page', () => {
    render(<Overlay onClose={jest.fn<AnyFn>()} />);
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('wraps Shift+Tab backwards from the first element', () => {
    render(<Overlay onClose={jest.fn<AnyFn>()} />);
    screen.getByRole('button', { name: 'first' }).focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('pulls focus back when it is outside the panel', () => {
    render(<Overlay onClose={jest.fn<AnyFn>()} />);
    screen.getByRole('button', { name: 'outside' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('closes on Escape only when focus is inside (so stacked overlays close one at a time)', () => {
    const onClose = jest.fn<AnyFn>();
    render(<Overlay onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    screen.getByRole('button', { name: 'outside' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('table headers', () => {
  it('marks column headers with scope="col"', () => {
    const columns: Column<{ id: string }>[] = [
      { id: 'name', header: 'Name', render: () => 'x' },
      { id: 'status', header: 'Status', render: () => 'y' },
    ];
    render(
      <DataTable
        data={[{ id: '1' }]}
        columns={columns}
        isLoading={false}
        emptyState={{ icon: Users, title: 'none', description: '' }}
        getRowKey={(r) => r.id}
      />,
    );
    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) expect(th).toHaveAttribute('scope', 'col');
  });
});

describe('chart series encoding', () => {
  it('gives each series a dash pattern as well as a colour', () => {
    const prepared = prepareSeries(
      [
        { labels: { status: 'success' }, values: [{ time: 1, value: '1' }] },
        { labels: { status: 'failed' }, values: [{ time: 1, value: '2' }] },
      ],
      'status',
    );
    expect(prepared.map((s) => s.label)).toEqual(['success', 'failed']);
    // Distinct colours AND distinct dashes — colour alone can't carry identity.
    expect(new Set(prepared.map((s) => s.color)).size).toBe(2);
    expect(prepared[0].dash).toBe(SERIES_DASHES[0]);
    expect(prepared[1].dash).toBe(SERIES_DASHES[1]);
    expect(prepared[0].dash).not.toBe(prepared[1].dash);
  });
});

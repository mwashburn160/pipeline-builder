// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TabBar follows the WAI-ARIA tabs pattern for in-page tabs, and stays a nav of
 * links for page-to-page tabs.
 *
 * In-page tabs are not buttons with `aria-current="page"` — that announces
 * "current page" for something that isn't a page, gives no "tab 2 of 4", and
 * puts every tab in the Tab order. Instead: one tablist, `aria-selected`, a single
 * tab stop that follows the selection, arrow/Home/End to move, and an optional
 * tab→panel id pair.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabBar, tabPanelProps, type TabBarItem } from '../src/components/ui/TabBar';

const ITEMS: TabBarItem[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
  { id: 'd', label: 'Delta' },
];

function Harness({ disabledIds, idPrefix }: { disabledIds?: string[]; idPrefix?: string }) {
  const [active, setActive] = useState('a');
  return (
    <>
      <TabBar items={ITEMS} activeId={active} onSelect={setActive} disabledIds={disabledIds} idPrefix={idPrefix} ariaLabel="Sections" />
      {idPrefix && <div {...tabPanelProps(idPrefix, active)}>panel {active}</div>}
    </>
  );
}

describe('TabBar — state tabs', () => {
  it('renders a labelled tablist of tabs with aria-selected, not aria-current', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    for (const tab of tabs) expect(tab).not.toHaveAttribute('aria-current');
  });

  it('has exactly one tab stop, on the selected tab', () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    fireEvent.click(tabs[2]);
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
  });

  it('moves and selects with ArrowRight/ArrowLeft, wrapping at both ends', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Beta' }), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Delta' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Delta' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Delta' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveFocus();
  });

  it('jumps with Home and End', () => {
    render(<Harness />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Delta' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Delta' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  });

  it('skips disabled tabs when moving with the keyboard', () => {
    render(<Harness disabledIds={['b']} />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Beta' })).toBeDisabled();
  });

  it('ignores other keys', () => {
    const onSelect = jest.fn<AnyFn>();
    render(<TabBar items={ITEMS} activeId="a" onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alpha' }), { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('wires tab ↔ panel ids when given an idPrefix', () => {
    render(<Harness idPrefix="demo" />);
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('id', 'demo-tab-a');
    expect(alpha).toHaveAttribute('aria-controls', 'demo-panel-a');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'demo-panel-a');
    // The panel is named by its tab.
    expect(screen.getByRole('tabpanel', { name: 'Alpha' })).toBe(panel);
  });

  it('points at no panel when it has no idPrefix (a dangling aria-controls is worse than none)', () => {
    render(<Harness />);
    expect(screen.getByRole('tab', { name: 'Alpha' })).not.toHaveAttribute('aria-controls');
  });
});

describe('TabBar — navigation tabs', () => {
  const LINKS: TabBarItem[] = [
    { id: 'queue', label: 'Queue', href: '/dashboard/build-queue' },
    { id: 'failed', label: 'Failed', href: '/dashboard/triage' },
  ];

  it('stays a nav of links with aria-current on the current page', () => {
    render(<TabBar items={LINKS} activeId="failed" />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Failed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Queue' })).not.toHaveAttribute('aria-current');
  });

  it('renders a disabled link as inert text', () => {
    render(<TabBar items={LINKS} activeId="queue" disabledIds={['failed']} />);
    expect(screen.queryByRole('link', { name: 'Failed' })).toBeNull();
    expect(screen.getByText('Failed')).toHaveAttribute('aria-disabled', 'true');
  });
});

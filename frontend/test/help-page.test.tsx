// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render tests for the redesigned Help page. These pin the behaviours the
 * redesign exists to deliver:
 *   - searching REPLACES the category browse (results aren't below the fold)
 *   - a hit names the sections it matched and shows a highlighted snippet
 *   - the top hit opens automatically
 *   - clear / `/` shortcut / empty state actually work
 */

import { describe, it, expect, jest } from '@jest/globals';
import { WHATS_NEW } from '../src/lib/help/whats-new';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import HelpPage from '../pages/dashboard/help';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

// framer-motion's AnimatePresence keeps collapsed content out of the DOM;
// reduce it to plain divs so assertions see the rendered body.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children, ...p }: { children?: ReactNode } & Record<string, unknown>) => <div {...p}>{children ?? null}</div> }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The topic corpus is a dynamic import, so whichever test renders first pays the
// transpile cost for 588 KB of generated source. That lands well inside the default
// 5s alone, but not when the whole frontend suite runs in parallel on a busy machine.
jest.setTimeout(30_000);

const search = () => screen.getByLabelText(/search the docs/i) as HTMLInputElement;

/**
 * Render and wait for the help corpus.
 *
 * The topics are a dynamic import now (588 KB of generated source that used to
 * sit in every chunk), so the browse view fills in one tick after mount.
 */
async function renderHelp() {
  const result = render(<HelpPage />);
  await screen.findByText('Deploy & Operate');
  return result;
}

describe('Help page — browse view', () => {
  it('shows the category index with topic counts when idle', async () => {
    await renderHelp();
    expect(screen.getByText('Deploy & Operate')).toBeInTheDocument();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    // Idle status line orients rather than sitting blank.
    expect(screen.getByText(/topics\./i)).toBeInTheDocument();
  });

  it('offers popular queries that populate the search box', async () => {
    await renderHelp();
    fireEvent.click(screen.getByRole('button', { name: 'aws ses' }));
    expect(search().value).toBe('aws ses');
  });
});

describe('Help page — search results', () => {
  it('replaces the category browse with ranked results', async () => {
    await renderHelp();
    expect(screen.getByText('Governance')).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: 'compliance' } });
    // Category headings are gone — results occupy the space directly below the input.
    expect(screen.queryByText('Governance')).not.toBeInTheDocument();
    // Both the status line and each result card mention matching sections.
    expect(screen.getAllByText(/matching section/i).length).toBeGreaterThan(1);
  });

  it('reports how many sections matched, not just how many topics', async () => {
    await renderHelp();
    fireEvent.change(search(), { target: { value: 'deploy' } });
    const status = screen.getByText(/of \d+ topics/);
    expect(status.textContent).toMatch(/\d+ matching sections?/);
  });

  it('highlights the query inside the snippet', async () => {
    const { container } = await renderHelp();
    fireEvent.change(search(), { target: { value: 'compliance' } });
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent?.toLowerCase()).toBe('compliance');
  });

  it('shows an actionable empty state for a term with no hits', async () => {
    await renderHelp();
    fireEvent.change(search(), { target: { value: 'zzzznotathing' } });
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back to all topics/i }));
    expect(search().value).toBe('');
    expect(screen.getByText('Governance')).toBeInTheDocument();
  });

  it('clears via the clear button and returns to browse', async () => {
    await renderHelp();
    fireEvent.change(search(), { target: { value: 'compliance' } });
    fireEvent.click(screen.getByLabelText(/clear search/i));
    expect(search().value).toBe('');
    expect(screen.getByText('Deploy & Operate')).toBeInTheDocument();
  });
});

describe('Help page — keyboard', () => {
  it('focuses search on "/" from elsewhere on the page', async () => {
    await renderHelp();
    search().blur();
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(search());
  });

  it('does not hijack "/" while typing in the field', async () => {
    await renderHelp();
    const input = search();
    fireEvent.change(input, { target: { value: 'a/b' } });
    expect(input.value).toBe('a/b');
  });

  it('Escape clears the query', async () => {
    await renderHelp();
    fireEvent.change(search(), { target: { value: 'compliance' } });
    // Dispatch on the input so it bubbles to the window listener with
    // event.target === the input, which is what the handler gates on.
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(search().value).toBe('');
  });
});

describe('Help page — what\'s new', () => {
  it('renders the feed with dates', async () => {
    await renderHelp();
    const feed = screen.getByText(/what's new/i).closest('div')!;
    for (const entry of WHATS_NEW) {
      expect(within(feed).getAllByText(new RegExp(entry.date)).length).toBeGreaterThan(0);
      expect(within(feed).getByText(entry.title)).toBeInTheDocument();
    }
  });
});

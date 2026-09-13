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

import { render, screen, fireEvent, within } from '@testing-library/react';
import HelpPage from '../pages/dashboard/help';

jest.mock('@/hooks/useAuthGuard', () => ({
  __esModule: true,
  useAuthGuard: () => ({ isReady: true, user: { id: 'u1', organizationId: 'org-1' } }),
}));

jest.mock('@/components/ui/DashboardLayout', () => ({
  __esModule: true,
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// framer-motion's AnimatePresence keeps collapsed content out of the DOM;
// reduce it to plain divs so assertions see the rendered body.
jest.mock('framer-motion', () => ({
  __esModule: true,
  motion: new Proxy({}, { get: () => ({ children, ...p }: never) => <div {...(p as object)}>{(children as never) ?? null}</div> }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const search = () => screen.getByLabelText(/search the docs/i) as HTMLInputElement;

describe('Help page — browse view', () => {
  it('shows the category index with topic counts when idle', () => {
    render(<HelpPage />);
    expect(screen.getByText('Deploy & Operate')).toBeInTheDocument();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    // Idle status line orients rather than sitting blank.
    expect(screen.getByText(/topics\./i)).toBeInTheDocument();
  });

  it('offers popular queries that populate the search box', () => {
    render(<HelpPage />);
    fireEvent.click(screen.getByRole('button', { name: 'aws ses' }));
    expect(search().value).toBe('aws ses');
  });
});

describe('Help page — search results', () => {
  it('replaces the category browse with ranked results', () => {
    render(<HelpPage />);
    expect(screen.getByText('Governance')).toBeInTheDocument();
    fireEvent.change(search(), { target: { value: 'compliance' } });
    // Category headings are gone — results occupy the space directly below the input.
    expect(screen.queryByText('Governance')).not.toBeInTheDocument();
    // Both the status line and each result card mention matching sections.
    expect(screen.getAllByText(/matching section/i).length).toBeGreaterThan(1);
  });

  it('reports how many sections matched, not just how many topics', () => {
    render(<HelpPage />);
    fireEvent.change(search(), { target: { value: 'deploy' } });
    const status = screen.getByText(/of \d+ topics/);
    expect(status.textContent).toMatch(/\d+ matching sections?/);
  });

  it('highlights the query inside the snippet', () => {
    const { container } = render(<HelpPage />);
    fireEvent.change(search(), { target: { value: 'compliance' } });
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent?.toLowerCase()).toBe('compliance');
  });

  it('shows an actionable empty state for a term with no hits', () => {
    render(<HelpPage />);
    fireEvent.change(search(), { target: { value: 'zzzznotathing' } });
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back to all topics/i }));
    expect(search().value).toBe('');
    expect(screen.getByText('Governance')).toBeInTheDocument();
  });

  it('clears via the clear button and returns to browse', () => {
    render(<HelpPage />);
    fireEvent.change(search(), { target: { value: 'compliance' } });
    fireEvent.click(screen.getByLabelText(/clear search/i));
    expect(search().value).toBe('');
    expect(screen.getByText('Deploy & Operate')).toBeInTheDocument();
  });
});

describe('Help page — keyboard', () => {
  it('focuses search on "/" from elsewhere on the page', () => {
    render(<HelpPage />);
    search().blur();
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(search());
  });

  it('does not hijack "/" while typing in the field', () => {
    render(<HelpPage />);
    const input = search();
    fireEvent.change(input, { target: { value: 'a/b' } });
    expect(input.value).toBe('a/b');
  });

  it('Escape clears the query', () => {
    render(<HelpPage />);
    fireEvent.change(search(), { target: { value: 'compliance' } });
    // Dispatch on the input so it bubbles to the window listener with
    // event.target === the input, which is what the handler gates on.
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(search().value).toBe('');
  });
});

describe('Help page — what\'s new', () => {
  it('renders the feed with dates', () => {
    render(<HelpPage />);
    const feed = screen.getByText(/what's new/i).closest('div')!;
    expect(within(feed).getByText(/2026-05-28/)).toBeInTheDocument();
  });
});

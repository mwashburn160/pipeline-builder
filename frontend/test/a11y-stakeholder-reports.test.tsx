// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Accessibility of the stakeholder-report surfaces — the WCAG AA audit the plan's launch
 * checklist asks for, as assertions rather than a one-off manual pass.
 *
 * These pages have an unusual audience for this product: the SHARED REPORT and the
 * confirm / unsubscribe pages are read by managers and executives who have no account here,
 * on whatever device and with whatever assistive technology they already use. They cannot
 * ask an admin to fix a missing label, and they will not report it — they will just not read
 * the report. That makes these the surfaces where a11y matters most and where nobody
 * internally would notice a regression.
 *
 * Asserted per criterion, in the repo's existing style (see `a11y-overlays-and-charts`),
 * rather than with a generic sweep: a rule-engine pass over jsdom is good at finding a
 * missing `alt` and blind to "the only thing distinguishing a locked panel is its colour".
 *
 *  - 1.1.1 / 4.1.2 — every icon is decorative (`aria-hidden`) or has an accessible name.
 *  - 1.3.1        — a real heading structure, and form controls tied to their labels.
 *  - 1.4.1        — state is never colour alone: locked, paused and preview all say so in
 *                   words.
 *  - 4.1.3        — loading, success and failure are announced, not merely rendered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';

const mockGetShared = jest.fn<AnyFn>();
const mockUnsubscribe = jest.fn<AnyFn>();
const mockRouter = { isReady: true, query: { token: 't'.repeat(40) } as Record<string, unknown> };

jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

// `PublicLayout` renders the public header, which reads the session to decide whether to
// offer "Sign in" or "Dashboard". These pages are reached by people with NO session, which is
// exactly the case being tested, so the hook is stubbed to that.
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({
  user: null, isAuthenticated: false, loading: false,
})));

jest.mock('@/lib/api/domains/stakeholder-reports-public', () => ({
  __esModule: true,
  getSharedReport: (...a: unknown[]) => mockGetShared(...(a as [])),
  unsubscribeFromReports: (...a: unknown[]) => mockUnsubscribe(...(a as [])),
  confirmReportRecipientEmail: jest.fn(),
}));

import SharedReportPage from '../pages/reports/shared';
import UnsubscribePage from '../pages/reports/unsubscribe';

const report = (over: Record<string, unknown> = {}) => ({
  periodLabel: '2026-W38',
  periodStart: '2026-09-14T00:00:00Z',
  periodEnd: '2026-09-21T00:00:00Z',
  version: 1,
  publishedAt: '2026-09-21T08:00:00Z',
  leadNotes: 'We paused deploys on Tuesday for the database migration.',
  snapshot: {
    sections: [
      { id: 'success_rate', title: 'Build success rate', state: 'ok', current: 91 },
      { id: 'dora', title: 'Deploys', state: 'locked', requiresFeature: 'advanced_reporting' },
      { id: 'broken', title: 'Plugin health', state: 'failed' },
    ],
    methodology: 'Computed over the window shown.',
  },
  namesRedacted: true,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // The public layout's dark-mode hook reads the media query at first render; jsdom has no
  // implementation, and these pages must render for somebody arriving from an email
  // regardless of their colour-scheme preference.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: jest.fn<AnyFn>(),
      removeEventListener: jest.fn<AnyFn>(),
      addListener: jest.fn<AnyFn>(),
      removeListener: jest.fn<AnyFn>(),
      dispatchEvent: jest.fn<AnyFn>(),
      onchange: null,
    }),
  });
  mockRouter.query = { token: 't'.repeat(40) };
  mockGetShared.mockResolvedValue({ success: true, data: { report: report(), expiresAt: '2026-10-21T00:00:00Z' } });
  mockUnsubscribe.mockResolvedValue({ success: true });
});

describe('the shared report page', () => {
  it('has one top-level heading naming what the page is', async () => {
    render(<SharedReportPage />);
    // 2.4.6 / 1.3.1: a reader arriving from an email needs the page to say what it is
    // before anything else, and a screen reader's heading list is how they find out.
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1.textContent).toContain('Delivery report');
  });

  it('announces that it is loading, rather than rendering an empty page', () => {
    mockGetShared.mockReturnValue(new Promise(() => undefined));
    render(<SharedReportPage />);
    // 4.1.3: without a live region, a screen-reader user hears nothing at all while the
    // request is in flight and cannot tell a slow page from a broken one.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('puts the lead\'s own words before the numbers', async () => {
    render(<SharedReportPage />);
    const notes = await screen.findByTestId('shared-report-notes');
    const sections = screen.getByRole('region', { name: /report sections/i });
    // Reading order is meaning: the context the data cannot supply has to come first, or a
    // reader has formed a view of the dip before reaching the sentence explaining it.
    // `contains` is false for siblings, so this is a genuine document-order check.
    expect(notes.compareDocumentPosition(sections)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('groups the sections in a named region', async () => {
    render(<SharedReportPage />);
    // 1.3.1: a landmark, so the tables can be skipped or jumped to as a unit.
    await waitFor(() => expect(screen.getByRole('region', { name: /report sections/i })).toBeTruthy());
  });

  it('says in WORDS that a panel is locked, not only in colour', async () => {
    render(<SharedReportPage />);
    // 1.4.1. The locked state is shown with a lock icon and a grey badge; without the text
    // a reader who cannot distinguish the badge sees an empty panel and assumes zero.
    await waitFor(() => expect(screen.getByText(/not on your plan/i)).toBeTruthy());
  });

  it('says in words that names were redacted', async () => {
    render(<SharedReportPage />);
    await waitFor(() => expect(screen.getByTestId('shared-report-redacted').textContent)
      .toMatch(/names have been replaced/i));
  });

  it('marks every decorative icon aria-hidden', async () => {
    const { container } = render(<SharedReportPage />);
    await screen.findByRole('heading', { level: 1 });
    // 1.1.1: these icons repeat information the adjacent text already carries, so an
    // unlabelled one is pure noise in a screen reader.
    for (const svg of Array.from(container.querySelectorAll('svg'))) {
      const labelled = svg.getAttribute('aria-label') ?? svg.getAttribute('role');
      expect(svg.getAttribute('aria-hidden') === 'true' || labelled !== null).toBe(true);
    }
  });

  it('tells a reader with a dead link what to do, without saying why it died', async () => {
    mockGetShared.mockResolvedValue({ success: false });
    render(<SharedReportPage />);
    const gone = await screen.findByTestId('shared-report-gone');
    expect(gone.textContent).toMatch(/ask whoever shared it/i);
    // The server answers one indistinguishable 404 for expired, revoked and never-existed, so
    // this page must not claim WHICH. Naming both possibilities generically ("links expire,
    // and can be withdrawn") is fine and useful; asserting one of them would tell whoever
    // found the URL that the report exists and somebody pulled it.
    expect(gone.textContent).not.toMatch(/was revoked|has been revoked|expired on|was withdrawn|no longer exists/i);
  });

  it('distinguishes a transport failure from a dead link', async () => {
    mockGetShared.mockRejectedValue(new Error('network down'));
    render(<SharedReportPage />);
    // Telling somebody with a perfectly good link to go and ask for a new one wastes two
    // people's time.
    const err = await screen.findByTestId('shared-report-error');
    expect(err.textContent).toMatch(/link itself is probably fine/i);
  });

  it('treats a missing token as a dead link rather than crashing', async () => {
    mockRouter.query = {};
    render(<SharedReportPage />);
    await waitFor(() => expect(screen.getByTestId('shared-report-gone')).toBeTruthy());
    expect(mockGetShared).not.toHaveBeenCalled();
  });

  it('keeps itself out of search engines and out of the next referrer', () => {
    // The URL is the credential, so these two tags are the difference between "a link that
    // expires" and "a report indexed on the open web". `next/head` renders nothing in jsdom,
    // so they are asserted at the source of truth rather than in the DOM.
    const text = readFileSync(join(__dirname, '../pages/reports/shared.tsx'), 'utf8');
    expect(text).toContain('name="robots" content="noindex, nofollow"');
    expect(text).toContain('name="referrer" content="no-referrer"');
  });
});

describe('the unsubscribe page', () => {
  it('announces the outcome, and says how far the unsubscribe reaches', async () => {
    render(<UnsubscribePage />);
    const done = await screen.findByTestId('unsubscribe-done');
    // The scope is the part people get wrong: it applies to EVERY report from that
    // organization, not only the one they clicked it in.
    expect(done.textContent).toMatch(/every\s+report/i);
  });

  it('has a heading, so it is not a bare sentence in a page', async () => {
    render(<UnsubscribePage />);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toMatch(/unsubscribe/i);
  });

  it('tells somebody who arrived without a token what to do', async () => {
    mockRouter.query = {};
    render(<UnsubscribePage />);
    await waitFor(() => expect(screen.getByText(/no unsubscribe token/i)).toBeTruthy());
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('offers a route out when the unsubscribe itself fails', async () => {
    mockUnsubscribe.mockRejectedValue(new Error('network'));
    render(<UnsubscribePage />);
    // A dead end here is how an unsubscribe becomes a spam complaint.
    const err = await screen.findByTestId('unsubscribe-error');
    expect(err.textContent).toMatch(/reply to the report email/i);
  });
});

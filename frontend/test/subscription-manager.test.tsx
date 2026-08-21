// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SubscriptionManager catalog gating: a published rule tagged into a paid
 * content set (`set:standard` / `set:advanced`) the org does NOT hold must show
 * a locked "Requires <Set>" affordance deep-linking to billing instead of a
 * Subscribe button (server gates subscribe/activate, so we avoid a 403 round
 * trip). A set badge renders on any set-tagged row; a held set stays Subscribe.
 * Auto-subscribe surfaces its {subscribed, skipped} counts in a toast.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SubscriptionManager from '../src/components/compliance/SubscriptionManager';
import type { PublishedRuleCatalogEntry } from '../src/types/compliance';

// Per-test toggle for the org's held compliance features.
let mockEnabled = new Set<string>();
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    isEnabled: (f: string) => mockEnabled.has(f),
    features: [...mockEnabled],
    isLoaded: true,
    supportAlias: 'support@pipeline-builder',
    supportAliases: ['support@pipeline-builder'],
  }),
}));

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: toastSuccess, error: toastError, warning: jest.fn(), info: jest.fn() }),
}));

// next/link → plain anchor so we can assert the href.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const getComplianceSubscriptions = jest.fn();
const getPublishedRules = jest.fn();
const subscribeToRule = jest.fn();
const autoSubscribe = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getComplianceSubscriptions: (...a: unknown[]) => getComplianceSubscriptions(...a),
    getPublishedRules: (...a: unknown[]) => getPublishedRules(...a),
    subscribeToRule: (...a: unknown[]) => subscribeToRule(...a),
    autoSubscribe: (...a: unknown[]) => autoSubscribe(...a),
  },
}));

function rule(over: Partial<PublishedRuleCatalogEntry>): PublishedRuleCatalogEntry {
  return {
    id: 'r1', orgId: 'system', name: 'Rule', priority: 0, target: 'plugin',
    severity: 'warning', tags: [], scope: 'published', suppressNotification: false,
    isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'sys',
    subscribed: false, ...over,
  };
}

function mockCatalog(rules: PublishedRuleCatalogEntry[]) {
  getPublishedRules.mockResolvedValue({
    success: true,
    data: { rules, pagination: { total: rules.length, limit: 10, offset: 0, hasMore: false } },
  });
}

async function openCatalog() {
  render(<SubscriptionManager />);
  fireEvent.click(await screen.findByRole('button', { name: /browse catalog/i }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled = new Set();
  getComplianceSubscriptions.mockResolvedValue({
    success: true,
    data: { subscriptions: [], pagination: { total: 0, limit: 10, offset: 0, hasMore: false } },
  });
});

describe('SubscriptionManager catalog set-gating', () => {
  it('shows a locked "Requires Standard" deep-link (not Subscribe) for an unheld set rule', async () => {
    mockCatalog([rule({ id: 'std-1', name: 'SOC2 rule', tags: ['set:standard'] })]);
    await openCatalog();

    const link = await screen.findByRole('link', { name: /requires standard/i });
    expect(link).toHaveAttribute('href', '/dashboard/billing?highlight=compliance_standard');
    expect(screen.queryByRole('button', { name: /^subscribe$/i })).not.toBeInTheDocument();
  });

  it('renders the set badge (Standard / Advanced) on set-tagged rows', async () => {
    mockCatalog([
      rule({ id: 'std-1', name: 'Std rule', tags: ['set:standard'] }),
      rule({ id: 'adv-1', name: 'Adv rule', tags: ['set:advanced'] }),
    ]);
    await openCatalog();

    await screen.findByText('Std rule');
    // Badge label + the "Requires <set>" affordance both carry the word; assert ≥1 each.
    expect(screen.getAllByText('Standard').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Advanced').length).toBeGreaterThan(0);
  });

  it('shows Subscribe (no lock) when the org HOLDS the gating feature', async () => {
    mockEnabled = new Set(['compliance_standard']);
    mockCatalog([rule({ id: 'std-1', name: 'Std rule', tags: ['set:standard'] })]);
    await openCatalog();

    expect(await screen.findByRole('button', { name: /subscribe/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /requires standard/i })).not.toBeInTheDocument();
    // Badge still renders on the row.
    expect(screen.getByText('Standard')).toBeInTheDocument();
  });

  it('shows Subscribe for an un-tagged (baseline) rule', async () => {
    mockCatalog([rule({ id: 'base-1', name: 'Baseline rule', tags: [] })]);
    await openCatalog();

    expect(await screen.findByRole('button', { name: /subscribe/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /requires/i })).not.toBeInTheDocument();
  });

  it('surfaces auto-subscribe {subscribed, skipped} counts in a success toast', async () => {
    autoSubscribe.mockResolvedValue({ success: true, data: { subscribed: 3, skipped: 2 } });
    render(<SubscriptionManager />);
    // Empty subscriptions tab → the "Auto-Subscribe to All" CTA is shown.
    fireEvent.click(await screen.findByRole('button', { name: /auto-subscribe to all/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0][0]).toMatch(/subscribed to 3 rules.*skipped 2/i);
  });
});

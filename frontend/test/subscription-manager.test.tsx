// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SubscriptionManager catalog gating: a published rule tagged into a paid
 * content set (`set:standard` / `set:advanced`) the org does NOT hold must show
 * a locked "Requires <Set>" affordance deep-linking to billing instead of a
 * Subscribe button (server gates subscribe/activate, so we avoid a 403 round
 * trip). A set badge renders on any set-tagged row; a held set stays Subscribe.
 * There is no bulk auto-subscribe control: that route is platform-internal (a
 * member can't mint subscriptions around the add-on gate), so the UI never
 * offers it. The sub-view lives in `?subs=` (deep-linkable).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
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

const toastSuccess = jest.fn<AnyFn>();
const toastError = jest.fn<AnyFn>();
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: toastSuccess, error: toastError, warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));

// useUrlTab reads/writes the query string; a replace() updates it in place.
const mockRouter = {
  query: {} as Record<string, string>,
  pathname: '/dashboard/compliance',
  isReady: true,
  replace: jest.fn<AnyFn>((url: { query: Record<string, string> }) => { mockRouter.query = url.query; return Promise.resolve(true); }),
};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

// next/link → plain anchor so we can assert the href.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const getComplianceSubscriptions = jest.fn<AnyFn>();
const getPublishedRules = jest.fn<AnyFn>();
const subscribeToRule = jest.fn<AnyFn>();
const unsubscribeFromRule = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    unsubscribeFromRule: (...a: unknown[]) => unsubscribeFromRule(...a),
    getComplianceSubscriptions: (...a: unknown[]) => getComplianceSubscriptions(...a),
    getPublishedRules: (...a: unknown[]) => getPublishedRules(...a),
    subscribeToRule: (...a: unknown[]) => subscribeToRule(...a),
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
  // Let the subscriptions read (fired on mount) settle before switching tabs,
  // then let the catalog read settle — otherwise one of them lands after the
  // test body has finished.
  await waitFor(() => expect(screen.queryByLabelText('Loading catalog')).not.toBeInTheDocument());
  fireEvent.click(await screen.findByRole('tab', { name: /browse catalog/i }));
  await waitFor(() => expect(screen.queryByLabelText('Loading catalog')).not.toBeInTheDocument());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled = new Set();
  mockRouter.query = {};
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

  it('offers no bulk auto-subscribe; the empty state points at the catalog instead', async () => {
    mockCatalog([rule({ id: 'base-1', name: 'Baseline rule', tags: [] })]);
    render(<SubscriptionManager />);
    fireEvent.click(await screen.findByRole('button', { name: /browse the catalog/i }));
    expect(screen.queryByRole('button', { name: /auto-subscribe/i })).not.toBeInTheDocument();
    expect(await screen.findByText('Baseline rule')).toBeInTheDocument();
    expect(mockRouter.query.subs).toBe('catalog');
  });

  it('opens straight on the catalog from a ?subs=catalog deep link', async () => {
    mockRouter.query = { subs: 'catalog' };
    mockCatalog([rule({ id: 'base-1', name: 'Baseline rule', tags: [] })]);
    render(<SubscriptionManager />);
    expect(await screen.findByText('Baseline rule')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /browse catalog/i })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('SubscriptionManager write gating (compliance:write)', () => {
  // ComplianceDashboard passes readOnly={!canManage}, where canManage is
  // can('compliance:write') — false without the permission and in a read-only
  // impersonation session. Unsubscribe (DELETE /compliance/subscriptions/:ruleId)
  // is server-gated on compliance:write, so it must be gated exactly like Deactivate.
  const subscription = {
    id: 's1', orgId: 'org-1', ruleId: 'rule-1', isActive: true, subscribedAt: '2026-01-01', subscribedBy: 'me',
    rule: { id: 'rule-1', orgId: 'system', name: 'Pinned images', severity: 'warning', target: 'plugin', priority: 0,
      tags: [], scope: 'published', suppressNotification: false, isActive: true, createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'sys' },
  };

  beforeEach(() => {
    getComplianceSubscriptions.mockResolvedValue({
      success: true,
      data: { subscriptions: [subscription], pagination: { total: 1, limit: 10, offset: 0, hasMore: false } },
    });
    unsubscribeFromRule.mockResolvedValue({ success: true });
  });

  it('offers no Unsubscribe (or Deactivate) without write access', async () => {
    render(<SubscriptionManager readOnly />);
    await screen.findByText('Pinned images');
    expect(screen.queryByRole('button', { name: 'Unsubscribe' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });

  it('unsubscribes with write access', async () => {
    render(<SubscriptionManager />);
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    await waitFor(() => expect(unsubscribeFromRule).toHaveBeenCalledWith('rule-1'));
  });
});

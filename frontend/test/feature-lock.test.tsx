// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Entitlement gating, from the customer's side.
 *
 * A control whose route carries `requireFeature(...)` must say so BEFORE the
 * click. Two failure modes are being guarded against, and they pull in opposite
 * directions: leaving the control enabled (the click becomes a bare 403), and
 * hiding it entirely (the customer can't tell the product does the thing, let
 * alone that it's purchasable). The lock states below are the third option —
 * visible, disabled-or-diverted, and specific about what's missing.
 *
 * "Where to get it" splits two ways, and getting it wrong is silent. An ADD-ON
 * (`advanced_reporting`) deep-links to its card via `?highlight=`. A feature that
 * only comes with a PLAN (`bulk_operations` from Pro, `sso` from Team) has no
 * card to highlight: AddonGrid matches nothing, highlights nothing, and the
 * viewer lands on an add-on grid that never mentions what they clicked. Those
 * open the Plans tab and name the plan instead.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { FeatureLock, FeatureLockedAction } from '@/components/ui/FeatureLock';
import CreatePluginModal from '@/components/plugin/CreatePluginModal';

let features: string[] = [];
let isLoaded = true;
let isSuperAdmin = false;
// Whether the viewer can open /dashboard/billing at all (`billing:read`, and
// billing running in this deployment) — the upsell link's precondition.
let canReachBilling = true;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: (f: string) => features.includes(f), isLoaded, features, isSuperAdmin, canReachBilling }),
}));

jest.mock('@/hooks/useBuildStatus', () => ({
  __esModule: true,
  useBuildStatus: () => ({ status: 'idle', events: [], lastEvent: null }),
}));

beforeEach(() => {
  features = [];
  isLoaded = true;
  isSuperAdmin = false;
  canReachBilling = true;
});

describe('<FeatureLock>', () => {
  it('names the entitlement, what it unlocks, and where to get it', () => {
    render(<FeatureLock flag="advanced_reporting" />);
    expect(screen.getByText(/Advanced Reporting isn't included in your current plan/i)).toBeInTheDocument();
    expect(screen.getByTestId('feature-lock-advanced_reporting')).toHaveTextContent(/DORA metrics/i);
    expect(screen.getByRole('link', { name: /billing/i }))
      .toHaveAttribute('href', '/dashboard/billing?highlight=advanced_reporting');
  });

  it('sends a TIER-only feature to Plans and names the plan, not to a nonexistent add-on', () => {
    // `sso` is included from Team up and is not sold separately (the Pro-only
    // SSO bundle was withdrawn), so `?highlight=sso` would highlight nothing.
    render(<FeatureLock flag="sso" />);
    const lock = screen.getByTestId('feature-lock-sso');
    expect(lock).toHaveTextContent(/included from the Team plan and isn't sold separately/i);
    const link = screen.getByRole('link', { name: /Compare plans/i });
    expect(link).toHaveAttribute('href', '/dashboard/billing?tab=plans');
    expect(link.getAttribute('href')).not.toContain('highlight');
    expect(lock).not.toHaveTextContent(/add it to your plan/i);
  });

  it('tells a viewer who cannot open Billing to ask about an UPGRADE for a tier feature', () => {
    // "add it to your plan" is a lie when there is nothing to add.
    canReachBilling = false;
    render(<FeatureLock flag="sso" />);
    expect(screen.getByTestId('feature-lock-sso'))
      .toHaveTextContent(/Ask an organization owner or admin about upgrading the plan/i);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing for an entitled org', () => {
    features = ['advanced_reporting'];
    const { container } = render(<FeatureLock flag="advanced_reporting" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a superadmin (they hold every entitlement)', () => {
    isSuperAdmin = true;
    const { container } = render(<FeatureLock flag="advanced_reporting" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent until /config resolves, so an entitled org never flashes it', () => {
    isLoaded = false;
    const { container } = render(<FeatureLock flag="bulk_operations" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sends a viewer who cannot open Billing to a person, not a dead link', () => {
    // /dashboard/billing needs `billing:read`. A developer clicking "See it in
    // Billing" got a full-screen AccessDenied — the upsell replaced by a wall.
    canReachBilling = false;
    render(<FeatureLock flag="advanced_reporting" />);
    expect(screen.getByTestId('feature-lock-advanced_reporting'))
      .toHaveTextContent(/Ask an organization owner or admin to add it to your plan/i);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // It still says what's missing and what it buys.
    expect(screen.getByText(/Advanced Reporting isn't included in your current plan/i)).toBeInTheDocument();
    expect(screen.getByTestId('feature-lock-advanced_reporting')).toHaveTextContent(/DORA metrics/i);
  });
});

describe('<FeatureLockedAction>', () => {
  it('keeps the action visible, marked, and pointed at billing', () => {
    render(<FeatureLockedAction flag="bulk_operations" label="Bulk import" />);
    const link = screen.getByTestId('feature-locked-bulk_operations');
    expect(link).toHaveTextContent('Bulk import');
    // Bulk Operations comes with Pro and is not sold as a pack, so the CTA is
    // the Plans tab rather than a `?highlight=` that matches no card.
    expect(link).toHaveAttribute('href', '/dashboard/billing?tab=plans');
    expect(link).toHaveAttribute('title', expect.stringContaining('Bulk Operations'));
  });

  it('gets out of the way when the org holds the feature', () => {
    features = ['bulk_operations'];
    const { container } = render(<FeatureLockedAction flag="bulk_operations" label="Bulk import" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays visible and named — but inert, not a dead link — without billing access', () => {
    canReachBilling = false;
    render(<FeatureLockedAction flag="bulk_operations" label="Bulk import" />);
    const control = screen.getByTestId('feature-locked-bulk_operations');
    expect(control.tagName).toBe('BUTTON');
    expect(control).not.toHaveAttribute('href');
    expect(control).toHaveAttribute('aria-disabled', 'true');
    // Still keyboard-reachable (aria-disabled, not the `disabled` attribute that
    // drops it out of the tab order) and it names what's missing and who to ask.
    expect(control).toHaveAccessibleName(/Bulk import — requires Bulk Operations, not included in your plan\. It comes with the Pro plan\. Ask an organization owner or admin about upgrading/i);
  });
});

describe('the plugin AI builder is pre-gated on ai_generation', () => {
  const noop = () => {};

  it('shows the lock instead of the builder when the org lacks the entitlement', () => {
    // POST /plugins/generate carries requireFeature('ai_generation'), so the
    // builder could only ever 403 on Generate.
    render(<CreatePluginModal canPublish={false} onClose={noop} onCreated={noop} initialTab="ai" />);
    expect(screen.getByTestId('feature-lock-ai_generation')).toBeInTheDocument();
    // …and points at the two tabs that build a plugin without AI.
    expect(screen.getByText(/build a plugin without AI/i)).toBeInTheDocument();
  });

  it('renders the builder when the org holds it', () => {
    features = ['ai_generation'];
    render(<CreatePluginModal canPublish={false} onClose={noop} onCreated={noop} initialTab="ai" />);
    expect(screen.queryByTestId('feature-lock-ai_generation')).not.toBeInTheDocument();
  });
});

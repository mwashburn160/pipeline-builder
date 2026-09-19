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
 */
import { render, screen } from '@testing-library/react';
import { FeatureLock, FeatureLockedAction } from '@/components/ui/FeatureLock';
import CreatePluginModal from '@/components/plugin/CreatePluginModal';

let features: string[] = [];
let isLoaded = true;
let isSuperAdmin = false;
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: (f: string) => features.includes(f), isLoaded, features, isSuperAdmin }),
}));

jest.mock('@/hooks/useBuildStatus', () => ({
  __esModule: true,
  useBuildStatus: () => ({ status: 'idle', events: [], lastEvent: null }),
}));

beforeEach(() => {
  features = [];
  isLoaded = true;
  isSuperAdmin = false;
});

describe('<FeatureLock>', () => {
  it('names the entitlement, what it unlocks, and where to get it', () => {
    render(<FeatureLock flag="advanced_reporting" />);
    expect(screen.getByText(/Advanced Reporting isn't included in your current plan/i)).toBeInTheDocument();
    expect(screen.getByTestId('feature-lock-advanced_reporting')).toHaveTextContent(/DORA metrics/i);
    expect(screen.getByRole('link', { name: /billing/i }))
      .toHaveAttribute('href', '/dashboard/billing?highlight=advanced_reporting');
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
});

describe('<FeatureLockedAction>', () => {
  it('keeps the action visible, marked, and pointed at billing', () => {
    render(<FeatureLockedAction flag="bulk_operations" label="Bulk import" />);
    const link = screen.getByTestId('feature-locked-bulk_operations');
    expect(link).toHaveTextContent('Bulk import');
    expect(link).toHaveAttribute('href', '/dashboard/billing?highlight=bulk_operations');
    expect(link).toHaveAttribute('title', expect.stringContaining('Bulk Operations'));
  });

  it('gets out of the way when the org holds the feature', () => {
    features = ['bulk_operations'];
    const { container } = render(<FeatureLockedAction flag="bulk_operations" label="Bulk import" />);
    expect(container).toBeEmptyDOMElement();
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

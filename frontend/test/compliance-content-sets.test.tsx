// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ComplianceContentSets: the entitlement-gated curated-content section on the
 * compliance page. A HELD set renders as "Included"; an unheld set renders a
 * locked upsell whose CTA deep-links to the matching billing add-on
 * (`?highlight=compliance_standard` / `_advanced`).
 */

import { render, screen } from '@testing-library/react';
import ComplianceContentSets from '../src/components/compliance/ComplianceContentSets';

// Per-test toggle for which compliance feature flags the org holds.
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

// next/link → plain anchor so we can assert the href.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const hrefOf = (name: RegExp) => (screen.getByRole('link', { name }) as HTMLAnchorElement).getAttribute('href');

beforeEach(() => { mockEnabled = new Set(); });

describe('ComplianceContentSets', () => {
  it('shows an upsell for BOTH sets when the org holds neither, routing Advanced to Standard first', () => {
    render(<ComplianceContentSets />);
    expect(hrefOf(/unlock standard compliance/i)).toBe('/dashboard/billing?highlight=compliance_standard');
    // Advanced without Standard is billing-rejected, so its CTA points at
    // Standard (not compliance_advanced) while Standard is unheld.
    expect(hrefOf(/unlock advanced compliance/i)).toBe('/dashboard/billing?highlight=compliance_standard');
    // …and the dependency note is shown.
    expect(screen.getByText(/requires the standard compliance library/i)).toBeInTheDocument();
    // Neither is marked as included.
    expect(screen.queryByText('Included')).not.toBeInTheDocument();
  });

  it('marks the Standard set included (no upsell) while still upselling Advanced', () => {
    mockEnabled = new Set(['compliance_standard']);
    render(<ComplianceContentSets />);
    expect(screen.getByText('Included')).toBeInTheDocument();
    // Standard is held → no Standard upsell link.
    expect(screen.queryByRole('link', { name: /unlock standard compliance/i })).not.toBeInTheDocument();
    // Standard held → Advanced can be bought alone: CTA targets Advanced and the
    // "requires Standard" note is gone.
    expect(hrefOf(/unlock advanced compliance/i)).toBe('/dashboard/billing?highlight=compliance_advanced');
    expect(screen.queryByText(/requires the standard compliance library/i)).not.toBeInTheDocument();
  });

  it('shows no upsell links when the org holds both sets', () => {
    mockEnabled = new Set(['compliance_standard', 'compliance_advanced']);
    render(<ComplianceContentSets />);
    expect(screen.getAllByText('Included')).toHaveLength(2);
    expect(screen.queryByRole('link', { name: /unlock/i })).not.toBeInTheDocument();
  });
});

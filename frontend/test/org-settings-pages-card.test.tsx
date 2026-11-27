// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Integrations card on Settings → Organization links SSO and incident
 * reporting. An entitlement the plan lacks keeps the row listed and linked,
 * marked as off-plan: the page it opens renders the upsell.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, within } from '@testing-library/react';
import { OrgSettingsPagesCard } from '../src/components/settings/OrgSettingsPagesCard';

let enabled: string[] = [];
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: (f: string) => enabled.includes(f), isLoaded: true, isSuperAdmin: false, canReachBilling: true }),
}));

describe('OrgSettingsPagesCard', () => {
  it('marks an off-plan page but still links it', () => {
    enabled = ['advanced_reporting'];
    render(<OrgSettingsPagesCard showSso showIncidents />);
    const sso = screen.getByRole('link', { name: /single sign-on/i });
    expect(sso).toHaveAttribute('href', '/dashboard/settings/sso');
    expect(within(sso).getByText('Not on your plan')).toBeInTheDocument();
    const incidents = screen.getByRole('link', { name: /incident reporting/i });
    expect(within(incidents).queryByText('Not on your plan')).not.toBeInTheDocument();
  });

  it('renders nothing when the viewer may open neither page', () => {
    const { container } = render(<OrgSettingsPagesCard showSso={false} showIncidents={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

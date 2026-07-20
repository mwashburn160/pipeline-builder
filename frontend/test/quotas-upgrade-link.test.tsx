// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests QuotasReadOnly's point-of-friction → upgrade-path wiring. The footer
 * should route a billing-capable viewer to /dashboard/billing to raise limits,
 * while a viewer who can't act on billing keeps the "contact a sysadmin" copy,
 * and a team defers to the parent org.
 */

import { render, screen } from '@testing-library/react';
import { QuotasReadOnly } from '../src/components/quotas/QuotasReadOnly';

// DashboardLayout drags in router/auth/features providers — mock it to a plain
// wrapper so this stays a focused unit test of the footer's upgrade affordance.
jest.mock('@/components/ui/DashboardLayout', () => ({
  __esModule: true,
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const baseProps = { orgData: null, loading: false, activeOrgIsTeam: false };

describe('QuotasReadOnly — upgrade path', () => {
  it('shows an "Upgrade your plan" link to billing when the viewer can manage billing', () => {
    render(<QuotasReadOnly {...baseProps} canManageBilling={true} />);
    const link = screen.getByRole('link', { name: /upgrade your plan/i });
    expect(link).toHaveAttribute('href', '/dashboard/billing');
    expect(screen.queryByText(/contact a system administrator/i)).not.toBeInTheDocument();
  });

  it('keeps the sysadmin-contact copy when the viewer cannot manage billing', () => {
    render(<QuotasReadOnly {...baseProps} canManageBilling={false} />);
    expect(screen.getByText(/contact a system administrator/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /upgrade your plan/i })).not.toBeInTheDocument();
  });

  it('defers to the parent org for a team (no upgrade link even if billing-capable)', () => {
    render(<QuotasReadOnly {...baseProps} activeOrgIsTeam={true} canManageBilling={true} />);
    expect(screen.getByText(/these pooled limits are managed by an admin/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /upgrade your plan/i })).not.toBeInTheDocument();
  });
});

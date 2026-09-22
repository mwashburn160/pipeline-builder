// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A gated page, deep-linked by someone who can't read it, renders ONE refusal —
 * not its panels, and not a spinner that never resolves.
 *
 * `page-access.test.ts` proves every gated page contains the render; this proves
 * the render actually produces the refusal and suppresses the page body.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import CompliancePage from '../pages/dashboard/compliance';

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ pathname: '/dashboard/compliance', query: {}, isReady: true, push: jest.fn<AnyFn>(), replace: jest.fn<AnyFn>() })));
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

describe('CompliancePage without compliance:read', () => {
  it('renders the access-denied state instead of the dashboard', () => {
    mockAuthGuard({
      isReady: false,
      accessDenied: { kind: 'permission', permission: 'compliance:read', pathname: '/dashboard/compliance' },
    });
    render(<CompliancePage />);
    expect(screen.getByTestId('access-denied')).toBeInTheDocument();
    expect(screen.getByText('compliance:read')).toBeInTheDocument();
    // The page body (and therefore every fetch it would fire) never mounts.
    expect(screen.queryByText('Compliance')).not.toBeInTheDocument();
  });

  it('renders the page normally once the permission is held', () => {
    mockAuthGuard({ isReady: true, accessDenied: null, can: () => true });
    render(<CompliancePage />);
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });
});

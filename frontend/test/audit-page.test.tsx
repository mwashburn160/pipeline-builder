// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render tests for the audit-log page's new affordances:
 *   - the hash-chain "Verify integrity" button is sysadmin-only
 *   - the "Denied attempts" quick-filter toggles the action filter to
 *     `authz.denied` and clears cleanly
 */

import { render, screen, fireEvent } from '@testing-library/react';
import AuditPage from '../pages/dashboard/audit';

// useAuthGuard is swapped per-test to flip the sysadmin flag.
const authGuard = { isReady: true, user: { id: 'u1', organizationId: 'org-1' }, isSuperAdmin: false };
jest.mock('@/hooks/useAuthGuard', () => ({
  __esModule: true,
  useAuthGuard: () => authGuard,
}));

// The page reads router.query for deep-link hydration only.
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: {} }),
}));

// DashboardLayout drags in providers — reduce it to a passthrough wrapper.
jest.mock('@/components/ui/DashboardLayout', () => ({
  __esModule: true,
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const listAuditEvents = jest.fn();
const verifyAuditChain = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listAuditEvents: (...args: unknown[]) => listAuditEvents(...args),
    verifyAuditChain: (...args: unknown[]) => verifyAuditChain(...args),
  },
}));

beforeEach(() => {
  listAuditEvents.mockReset().mockResolvedValue({
    success: true,
    data: { events: [], pagination: { total: 0, offset: 0, limit: 50, hasMore: false } },
  });
  verifyAuditChain.mockReset();
  authGuard.isSuperAdmin = false;
});

describe('AuditPage — verify integrity gating', () => {
  it('shows the Verify integrity button for a sysadmin', async () => {
    authGuard.isSuperAdmin = true;
    render(<AuditPage />);
    expect(await screen.findByRole('button', { name: /verify integrity/i })).toBeInTheDocument();
  });

  it('hides the Verify integrity button for an org-admin', async () => {
    authGuard.isSuperAdmin = false;
    render(<AuditPage />);
    // Wait for the initial fetch to settle (empty-state renders) before asserting absence.
    expect(await screen.findByText(/no matching audit events/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verify integrity/i })).not.toBeInTheDocument();
  });

  it('reports an intact chain on a successful verify', async () => {
    authGuard.isSuperAdmin = true;
    verifyAuditChain.mockResolvedValue({ success: true, data: { ok: true, count: 7 } });
    render(<AuditPage />);
    fireEvent.click(await screen.findByRole('button', { name: /verify integrity/i }));
    expect(await screen.findByText(/chain intact \(7 events\)/i)).toBeInTheDocument();
    expect(verifyAuditChain).toHaveBeenCalledWith('org-1');
  });

  it('surfaces a tamper result with the broken-at id', async () => {
    authGuard.isSuperAdmin = true;
    verifyAuditChain.mockResolvedValue({ success: true, data: { ok: false, brokenAt: 'evt-42', count: 3 } });
    render(<AuditPage />);
    fireEvent.click(await screen.findByRole('button', { name: /verify integrity/i }));
    expect(await screen.findByText(/tamper detected/i)).toBeInTheDocument();
    expect(screen.getByText(/evt-42/)).toBeInTheDocument();
  });
});

describe('AuditPage — denied-attempts quick filter', () => {
  it('sets the action filter to authz.denied when toggled on, and clears it when toggled off', async () => {
    render(<AuditPage />);
    const chip = await screen.findByRole('button', { name: /denied attempts/i });
    const actionInput = screen.getByPlaceholderText(/filter by action/i) as HTMLInputElement;

    expect(actionInput.value).toBe('');
    fireEvent.click(chip);
    expect(actionInput.value).toBe('authz.denied');
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(chip);
    expect(actionInput.value).toBe('');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });
});

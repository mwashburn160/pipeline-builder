// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The "finish setting up your organization" popup.
 *
 * Before it, only the social-sign-up "Continue" path ever saw the setup steps:
 * an email/password registrant, a social user who pressed "Skip for now", and an
 * org created for someone landed on the dashboard with no word about the CLI,
 * the service tokens or event ingestion. The popup is shown once PER ORG to its
 * admins, decided on the server; "Remind me later" is local and lasts a day.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

type U = { id: string; organizationId?: string; permissions?: string[]; isSuperAdmin?: boolean };
let mockUser: U | null = null;
jest.mock('@/hooks/useFeatures', () => ({
  useFeatures: () => ({ deployTarget: 'aws-ec2', isEnabled: () => false, features: [], isLoaded: true, supportAlias: '', supportAliases: [], cliNpmPackage: '@acme/pb-cli', cliNpmUrl: 'https://x.test' }),
}));
let mockImpersonating = false;
let mockEnrolmentOnly = false;
jest.mock('@/lib/enrolment-session', () => ({ isEnrolmentPendingSession: () => mockEnrolmentOnly }));
const getSetupGuide = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const updateSetupGuide = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    isImpersonating: () => mockImpersonating,
    getSetupGuide: (...a: unknown[]) => getSetupGuide(...a),
    updateSetupGuide: (...a: unknown[]) => updateSetupGuide(...a),
    listServiceAccounts: async () => ({ data: { serviceAccounts: [] } }),
    getIngestHealth: async () => ({ health: null, now: new Date().toISOString() }),
  },
}));

import { SetupGuidePopup } from '../src/components/onboarding/SetupGuidePopup';
import { snoozeSetupGuide, SETUP_GUIDE_SNOOZE_MS, isSetupGuideSnoozed } from '../src/lib/setup-guide';

const ADMIN = ['org_settings:write', 'service_accounts:manage', 'reports:read'];
const fresh = { dismissedAt: null, dismissedBy: null, topLevel: true };
const TITLE = /finish setting up your organization/i;

beforeEach(() => {
  window.localStorage.clear();
  getSetupGuide.mockReset();
  updateSetupGuide.mockReset();
  updateSetupGuide.mockResolvedValue({ data: { ...fresh, dismissedAt: 'now' } });
  mockImpersonating = false;
  mockEnrolmentOnly = false;
  mockUser = { id: 'u1', organizationId: 'org-a', permissions: ADMIN };
});

describe('SetupGuidePopup — who sees it', () => {
  it('an admin of a new top-level org (e.g. an email/password sign-up) sees it', async () => {
    getSetupGuide.mockResolvedValue({ data: fresh });
    render(<SetupGuidePopup user={mockUser as never} />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(getSetupGuide).toHaveBeenCalledWith('org-a', expect.anything());
  });

  it('a plain member is never asked, and nothing is read', async () => {
    mockUser = { id: 'u2', organizationId: 'org-a', permissions: ['reports:read'] };
    getSetupGuide.mockResolvedValue({ data: fresh });
    render(<SetupGuidePopup user={mockUser as never} />);
    await act(async () => {});
    expect(getSetupGuide).not.toHaveBeenCalled();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('a superadmin switched into a customer org (implicit permissions only) is not asked', async () => {
    mockUser = { id: 'op', organizationId: 'org-a', permissions: [], isSuperAdmin: true };
    getSetupGuide.mockResolvedValue({ data: fresh });
    render(<SetupGuidePopup user={mockUser as never} />);
    await act(async () => {});
    expect(getSetupGuide).not.toHaveBeenCalled();
  });

  it('not in the system org', async () => {
    mockUser = { id: 'u1', organizationId: '000000000000000000000001', permissions: ADMIN };
    getSetupGuide.mockResolvedValue({ data: fresh });
    render(<SetupGuidePopup user={mockUser as never} />);
    await act(async () => {});
    expect(getSetupGuide).not.toHaveBeenCalled();
  });

  it('not during a read-only impersonation or an enrolment-only session', async () => {
    getSetupGuide.mockResolvedValue({ data: fresh });
    mockImpersonating = true;
    const { unmount } = render(<SetupGuidePopup user={mockUser as never} />);
    await act(async () => {});
    unmount();
    mockImpersonating = false;
    mockEnrolmentOnly = true;
    render(<SetupGuidePopup user={mockUser as never} />);
    await act(async () => {});
    expect(getSetupGuide).not.toHaveBeenCalled();
  });

  it('not for a team (it shares the parent org’s setup)', async () => {
    getSetupGuide.mockResolvedValue({ data: { ...fresh, topLevel: false } });
    render(<SetupGuidePopup user={mockUser as never} />);
    await waitFor(() => expect(getSetupGuide).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('not once any admin dismissed it for the org', async () => {
    getSetupGuide.mockResolvedValue({ data: { ...fresh, dismissedAt: '2026-11-01T00:00:00Z', dismissedBy: 'u9' } });
    render(<SetupGuidePopup user={mockUser as never} />);
    await waitFor(() => expect(getSetupGuide).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('a failed read shows nothing (it returns on a later load)', async () => {
    getSetupGuide.mockRejectedValue(new Error('boom'));
    render(<SetupGuidePopup user={mockUser as never} />);
    await waitFor(() => expect(getSetupGuide).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });
});

describe('SetupGuidePopup — answers', () => {
  it('"Done — don’t show again" records the dismissal on the org and closes', async () => {
    getSetupGuide.mockResolvedValue({ data: fresh });
    render(<SetupGuidePopup user={mockUser as never} />);
    fireEvent.click(await screen.findByRole('button', { name: /done — don't show again/i }));
    expect(updateSetupGuide).toHaveBeenCalledWith('org-a', { dismissed: true });
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('"Remind me later" writes nothing to the server and holds it off on this browser', async () => {
    getSetupGuide.mockResolvedValue({ data: fresh });
    const { unmount } = render(<SetupGuidePopup user={mockUser as never} />);
    fireEvent.click(await screen.findByRole('button', { name: /remind me later/i }));
    expect(updateSetupGuide).not.toHaveBeenCalled();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    unmount();
    getSetupGuide.mockClear();
    render(<SetupGuidePopup user={mockUser as never} />);
    await act(async () => {});
    expect(getSetupGuide).not.toHaveBeenCalled();
  });

  it('a second org the same admin creates gets its own popup', async () => {
    getSetupGuide.mockResolvedValue({ data: fresh });
    snoozeSetupGuide('org-a');
    mockUser = { id: 'u1', organizationId: 'org-b', permissions: ADMIN };
    render(<SetupGuidePopup user={mockUser as never} />);
    expect(await screen.findByText(TITLE)).toBeInTheDocument();
    expect(getSetupGuide).toHaveBeenCalledWith('org-b', expect.anything());
  });

  it('shows live progress inside the popup', async () => {
    getSetupGuide.mockResolvedValue({ data: fresh });
    render(<SetupGuidePopup user={mockUser as never} />);
    expect(await screen.findByRole('region', { name: /setup progress/i })).toBeInTheDocument();
  });
});

describe('snooze', () => {
  it('lasts a day, per org', () => {
    const t0 = 1_000_000;
    snoozeSetupGuide('org-a', t0);
    expect(isSetupGuideSnoozed('org-a', t0 + SETUP_GUIDE_SNOOZE_MS - 1)).toBe(true);
    expect(isSetupGuideSnoozed('org-a', t0 + SETUP_GUIDE_SNOOZE_MS + 1)).toBe(false);
    expect(isSetupGuideSnoozed('org-b', t0)).toBe(false);
  });
});

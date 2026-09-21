// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The number behind the grace period.
 *
 * An admin turning on "require two-factor" is choosing how long members have to
 * enrol — and the panel could not tell them whether that was everyone or nobody,
 * so "14 days" was a guess. The policy read now carries the enrolment counts and
 * the panel states them, loudly when people would be locked out.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MfaPolicySettings } from '../src/components/settings/MfaPolicySettings';
import type { OrgMfaPolicy } from '../src/types';

const getMfaPolicy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getMfaPolicy: (...a: unknown[]) => getMfaPolicy(...a),
    updateMfaPolicy: jest.fn<AnyFn>(),
  },
}));
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() }),
}));

let stepUpDetails: React.ReactNode = null;
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ details }: { details?: React.ReactNode }) => {
    stepUpDetails = details;
    return <div data-testid="stepup-details">{details}</div>;
  },
}));

const policy = (over: Partial<OrgMfaPolicy> = {}): OrgMfaPolicy => ({
  requireMfa: false,
  enforced: false,
  own: false,
  idpEnforcesMfa: false,
  adminActionsRequireMfa: false,
  adminActionsOwn: false,
  defaultGraceDays: 14,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  stepUpDetails = null;
});

async function renderPanel(p: OrgMfaPolicy) {
  getMfaPolicy.mockResolvedValue({ success: true, data: p });
  render(<MfaPolicySettings orgId="org-1" readOnly={false} />);
  await screen.findByText(/^require two-factor authentication$/i);
}

describe('MfaPolicySettings — who is ready', () => {
  it('states how many members already hold a factor', async () => {
    await renderPanel(policy({ enrolment: { members: 12, enrolled: 5, declined: 0 } }));
    expect(await screen.findByText(/5 of 12 members have a passkey or an authenticator app/i)).toBeInTheDocument();
    expect(screen.getByText(/7 people would be refused/i)).toBeInTheDocument();
  });

  it('says the requirement can be applied immediately when everyone has enrolled', async () => {
    await renderPanel(policy({ enrolment: { members: 4, enrolled: 4, declined: 0 } }));
    expect(await screen.findByText(/everyone can already sign in with two factors/i)).toBeInTheDocument();
  });

  it('uses singular wording for a one-person organization', async () => {
    await renderPanel(policy({ enrolment: { members: 1, enrolled: 0, declined: 0 } }));
    expect(await screen.findByText(/0 of 1 member has a passkey/i)).toBeInTheDocument();
    expect(screen.getByText(/1 person would be refused/i)).toBeInTheDocument();
  });

  it('shows nothing rather than a wrong number when the count is absent', async () => {
    await renderPanel(policy());
    expect(screen.queryByText(/would be refused/i)).not.toBeInTheDocument();
  });

  it('separates "hasn\'t got round to it" from "has decided not to"', async () => {
    // A reminder moves the first group and not the second, so an admin choosing
    // between sending one and setting a deadline needs both numbers.
    await renderPanel(policy({ enrolment: { members: 10, enrolled: 3, declined: 2 } }));
    expect(await screen.findByText(/2 of them have been asked and chose not to be reminded again/i)).toBeInTheDocument();
  });

  it('uses singular wording for one decliner', async () => {
    await renderPanel(policy({ enrolment: { members: 10, enrolled: 3, declined: 1 } }));
    expect(await screen.findByText(/one of them has been asked and chose not to be reminded again/i)).toBeInTheDocument();
  });

  it('says nothing about declines when there are none — and never names anyone', async () => {
    await renderPanel(policy({ enrolment: { members: 10, enrolled: 3, declined: 0 } }));
    expect(screen.queryByText(/chose not to be reminded/i)).not.toBeInTheDocument();
  });

  it('repeats the cost in the confirmation, where the decision is actually made', async () => {
    await renderPanel(policy({ enrolment: { members: 10, enrolled: 3, declined: 0 } }));
    fireEvent.click(screen.getByRole('switch', { name: /^require two-factor authentication$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(stepUpDetails).not.toBeNull());
    expect(screen.getByTestId('stepup-details')).toHaveTextContent(/7 of 10 today/i);
  });
});

describe('MfaPolicySettings — inherited requirement', () => {
  it('names the parent organization that imposes the requirement', async () => {
    await renderPanel(policy({ requireMfa: true, enforced: true, inheritedFrom: 'root-1', inheritedFromName: 'Acme Corp' }));
    const callout = screen.getByText('Acme Corp').closest('div')!;
    expect(callout).toHaveTextContent(/the parent organization acme corp already requires two-factor authentication/i);
  });

  it('falls back to generic copy when the parent\'s name is absent', async () => {
    await renderPanel(policy({ requireMfa: true, enforced: true, inheritedFrom: 'root-1' }));
    expect(screen.getByText(/a parent organization already requires two-factor authentication/i)).toBeInTheDocument();
  });
});

describe('MfaPolicySettings — administrative actions require MFA', () => {
  it('offers the toggle with honest copy about what it covers and who is signed out', async () => {
    await renderPanel(policy());
    expect(screen.getByRole('switch', { name: /administrative actions/i })).toBeInTheDocument();
    expect(screen.getByText(/managing roles, members, invitations/i)).toHaveTextContent(/signs every other member/i);
  });

  it('turning it ON is a tightening — no "weakens" warning', async () => {
    await renderPanel(policy());
    fireEvent.click(screen.getByRole('switch', { name: /administrative actions/i }));
    expect(screen.queryByText(/weakens your organization/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(stepUpDetails).not.toBeNull());
    expect(screen.getByTestId('stepup-details')).toHaveTextContent(/every other member is signed out/i);
  });

  it('turning it OFF warns that a two-factor session is needed', async () => {
    await renderPanel(policy({ adminActionsRequireMfa: true, adminActionsOwn: true }));
    fireEvent.click(screen.getByRole('switch', { name: /administrative actions/i }));
    expect(screen.getByText(/weakens your organization/i)).toBeInTheDocument();
  });

  it('names a parent that imposes it', async () => {
    await renderPanel(policy({ adminActionsRequireMfa: true, adminActionsOwn: false, adminActionsInheritedFrom: 'root-1', adminActionsInheritedFromName: 'Acme Corp' }));
    expect(screen.getByText('Acme Corp').closest('div')!).toHaveTextContent(/for administrative actions/i);
  });
});

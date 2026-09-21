// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org's EMAIL DOMAINS card. It has TWO consumers, and the copy has to serve
 * both: SSO setup sends admins here to verify a domain (a non-Google IdP's
 * sign-ins are refused for an unverified domain, and "require SSO" is refused
 * outright), and domain-based join matches on the same verified domains. The
 * upsell must name both — and say so plainly when the viewer holds `sso` but the
 * account is not on the tier that gates domain registration, which is otherwise
 * a dead end. That combination survives SSO becoming a Team-and-above TIER
 * feature: a superadmin holds every entitlement, and a per-user `sso` override
 * can put the flag on a member of a Developer/Pro org. Because SSO is no longer
 * purchasable, the CTA must lead to PLANS — `?highlight=sso` would land on an
 * add-on grid with no SSO card on it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DomainJoinSettings } from '../src/components/settings/DomainJoinSettings';
import { DOMAIN_SETTINGS_ANCHOR, DOMAIN_SETTINGS_HREF } from '../src/components/sso/VerifiedDomainPicker';

let ssoEntitled = false;
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({
    flag: 'sso', entitled: ssoEntitled, isLoaded: true, label: 'SSO / IdP',
    description: '', unlocks: '', upsellHref: '/dashboard/billing?tab=plans',
    upsellCta: 'Compare plans', upsellTrailer: '.',
    includedFromPlan: 'Team', reason: '',
  }),
}));

jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() }),
}));

const listOrgDomains = jest.fn<AnyFn>();
const listOrgJoinRequests = jest.fn<AnyFn>();
const addOrgDomain = jest.fn<AnyFn>();
const verifyOrgDomain = jest.fn<AnyFn>();
const deleteOrgDomain = jest.fn<AnyFn>();
const decideOrgJoinRequest = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOrgDomains: (...a: unknown[]) => listOrgDomains(...a),
    listOrgJoinRequests: (...a: unknown[]) => listOrgJoinRequests(...a),
    addOrgDomain: (...a: unknown[]) => addOrgDomain(...a),
    verifyOrgDomain: (...a: unknown[]) => verifyOrgDomain(...a),
    deleteOrgDomain: (...a: unknown[]) => deleteOrgDomain(...a),
    decideOrgJoinRequest: (...a: unknown[]) => decideOrgJoinRequest(...a),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  ssoEntitled = false;
  listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: true } });
  listOrgJoinRequests.mockResolvedValue({ success: true, data: { requests: [] } });
});

describe('DomainJoinSettings', () => {
  it('shows the empty state once loaded', async () => {
    render(<DomainJoinSettings orgId="org-1" />);
    expect(await screen.findByText(/No domains registered yet/i)).toBeInTheDocument();
  });

  it('is named and anchored for BOTH consumers, so the SSO wizard can deep link to it', async () => {
    const { container } = render(<DomainJoinSettings orgId="org-1" />);
    // The card used to be titled "Domain-based join" — a name about joining,
    // for a card SSO setup also sends people to.
    expect(await screen.findByText('Email domains')).toBeInTheDocument();
    expect(screen.getByText(/single sign-on serves/i)).toBeInTheDocument();
    // …and the wizard's link resolves to something on the page.
    expect(DOMAIN_SETTINGS_HREF).toBe(`/dashboard/settings?tab=organization#${DOMAIN_SETTINGS_ANCHOR}`);
    expect(container.querySelector(`#${DOMAIN_SETTINGS_ANCHOR}`)).not.toBeNull();
  });

  it('names BOTH things a verified domain unlocks (and no Add form) when not entitled', async () => {
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: false } });
    render(<DomainJoinSettings orgId="org-1" />);
    const note = await screen.findByText(/Registering a domain needs the Team or Enterprise tier/i);
    const box = note.closest('div')!.parentElement!;
    expect(box).toHaveTextContent(/single sign-on/i);
    expect(box).toHaveTextContent(/domain-based join/i);
    expect(screen.queryByPlaceholderText('acme.com')).not.toBeInTheDocument();
  });

  it('explains the dead end when the viewer holds SSO but the tier blocks domains', async () => {
    ssoEntitled = true;
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: false } });
    render(<DomainJoinSettings orgId="org-1" />);
    expect(await screen.findByText(/cannot be completed until the account is on Team or Enterprise/i)).toBeInTheDocument();
    // The CTA goes to PLANS, never to `?highlight=sso` — there is no SSO add-on
    // to highlight, so that link would drop the admin on a grid without it.
    const cta = screen.getByRole('link', { name: /Compare plans/i });
    expect(cta).toHaveAttribute('href', '/dashboard/billing?tab=plans');
    expect(cta.getAttribute('href')).not.toContain('highlight');
  });

  it('says nothing about SSO in the upsell when the viewer does not hold it', async () => {
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: false } });
    render(<DomainJoinSettings orgId="org-1" />);
    expect(await screen.findByText(/Registering a domain needs the Team or Enterprise tier/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Compare plans/i })).not.toBeInTheDocument();
  });

  it('names Google Workspace as the one provider exempt from domain verification', async () => {
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [], entitled: false } });
    render(<DomainJoinSettings orgId="org-1" />);
    const note = await screen.findByText(/Registering a domain needs the Team or Enterprise tier/i);
    expect(note.closest('div')!.parentElement!).toHaveTextContent(/Google Workspace is the one exception/i);
  });

  it('deletes a domain only after confirmation', async () => {
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [{ id: 'd1', domain: 'acme.com', verified: true, autoJoin: 'off' }], entitled: true } });
    deleteOrgDomain.mockResolvedValue({ success: true, data: { deleted: true } });
    render(<DomainJoinSettings orgId="org-1" />);

    fireEvent.click(await screen.findByLabelText('Delete acme.com'));
    // Not deleted yet — the confirm modal must be acknowledged first.
    expect(deleteOrgDomain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteOrgDomain).toHaveBeenCalledWith('org-1', 'd1'));
  });

  it('approves a pending join request', async () => {
    listOrgJoinRequests.mockResolvedValue({ success: true, data: { requests: [{ id: 'r1', userId: 'u1', email: 'jane@acme.com', requestedAt: '2026-01-01' }] } });
    decideOrgJoinRequest.mockResolvedValue({ success: true, data: { userId: 'u1', status: 'approved' } });
    render(<DomainJoinSettings orgId="org-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(decideOrgJoinRequest).toHaveBeenCalledWith('org-1', 'r1', 'approve'));
  });
  it('readOnly shows everything but offers no write — for read-only impersonation', async () => {
    // The Settings page used to HIDE this card under read-only impersonation
    // (it gated on the mutation-aware `can()`), so an investigating sysadmin
    // could not see the org's domains at all. It is now shown, disabled.
    listOrgDomains.mockResolvedValue({ success: true, data: { domains: [{ id: 'd1', domain: 'acme.com', verified: true, autoJoin: 'off' }], entitled: true } });
    listOrgJoinRequests.mockResolvedValue({ success: true, data: { requests: [{ id: 'r1', userId: 'u1', email: 'jane@acme.com', requestedAt: '2026-01-01' }] } });
    render(<DomainJoinSettings orgId="org-1" readOnly />);

    expect(await screen.findByText('acme.com')).toBeInTheDocument();
    expect(screen.getByText('jane@acme.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete acme.com')).toBeDisabled();
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /deny/i })).toBeDisabled();
    expect(screen.getByPlaceholderText('acme.com')).toBeDisabled();
  });
});

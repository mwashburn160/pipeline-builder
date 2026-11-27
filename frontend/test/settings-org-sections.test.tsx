// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Organization is split into sections (General, Security,
 * Pipelines, AI, Data) behind an ARIA tab switcher, with `?section=` in the
 * URL. Contract:
 *  - a section shows only when the viewer can see at least one of its cards,
 *    and the default is the first visible one;
 *  - switching writes `?section=` (shallow) and leaving the tab drops it;
 *  - every deep link into a card (`#email-domains`, `#pipeline-runners`,
 *    `#plugin-security`, and the hrefs built for them) opens its section;
 *  - the per-card permission conditions are unchanged — the union of what the
 *    sections show is exactly what the single long tab used to show.
 */

import { describe, it, expect, jest, beforeEach, afterEach, beforeAll } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { DOMAIN_SETTINGS_ANCHOR, DOMAIN_SETTINGS_HREF } from '../src/components/sso/VerifiedDomainPicker';
import { PIPELINE_RUNNERS_ANCHOR, PIPELINE_RUNNERS_HREF } from '../src/lib/pipeline-runners';
import { ORG_MFA_SETTINGS_HREF } from '../src/components/security/SecurityPostureStrip';
import { PLUGIN_SECURITY_ANCHOR, orgSettingsHref } from '../src/lib/org-settings-sections';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({ StepUpModal: () => null }));

// Every card is a marker: these tests are about WHERE a card mounts, not what it does.
jest.mock('@/components/settings/DomainJoinSettings', () => ({ DomainJoinSettings: () => <div id="email-domains">card:domains</div> }));
jest.mock('@/components/settings/SupportContactSettings', () => ({ SupportContactSettings: () => <div>card:support</div> }));
jest.mock('@/components/settings/ImpersonationPolicySettings', () => ({ ImpersonationPolicySettings: () => <div>card:impersonation</div> }));
jest.mock('@/components/settings/MfaPolicySettings', () => ({ MfaPolicySettings: () => <div>card:mfa</div> }));
jest.mock('@/components/settings/PasswordPolicySettings', () => ({ PasswordPolicySettings: () => <div>card:password</div> }));
jest.mock('@/components/settings/AuthenticatorPolicySettings', () => ({ AuthenticatorPolicySettings: () => <div>card:authenticators</div> }));
jest.mock('@/components/settings/SessionPolicySettings', () => ({ SessionPolicySettings: () => <div>card:session</div> }));
jest.mock('@/components/settings/PluginSecurityNotificationSettings', () => ({ PluginSecurityNotificationSettings: () => <div>card:plugin-security</div> }));
jest.mock('@/components/settings/PipelineRunnersSettings', () => ({ PipelineRunnersSettings: () => <div id="pipeline-runners">card:runners</div> }));
jest.mock('@/components/settings/PipelineToolchainSettings', () => ({ PipelineToolchainSettings: () => <div>card:toolchain</div> }));
jest.mock('@/components/settings/AIProviderConfig', () => ({ AIProviderConfig: () => <div>card:ai</div> }));
jest.mock('@/components/settings/OrgDataExport', () => ({ OrgDataExport: () => <div>card:export</div> }));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => null,
    getMyOrganization: async () => ({ success: true, data: { organization: { id: 'org-1', name: 'Acme', slug: 'acme' } } }),
  },
}));

let query: Record<string, string> = {};
const replace = jest.fn<AnyFn>(async () => true);
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query, pathname: '/dashboard/settings', replace, push: jest.fn<AnyFn>() })));

import SettingsPage from '../pages/dashboard/settings';

const scrollIntoView = jest.fn<AnyFn>();
beforeAll(() => { (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView; });

const ALL_CARDS = ['identity', 'domains', 'support', 'mfa', 'password', 'authenticators', 'session', 'impersonation', 'runners', 'toolchain', 'plugin-security', 'ai', 'export'];

function as(permissions: string[]) {
  mockAuthGuard({
    user: { id: 'u1', organizationId: 'org-1', organizationName: 'Acme', username: 'u', email: 'u@acme.com', isEmailVerified: true, permissions },
    can: (p: string) => permissions.includes(p),
  });
}
const ADMIN = ['org_settings:write', 'org_impersonation:write', 'pipelines:read', 'plugins:read', 'toolchain:manage'];

const sectionList = () => screen.getByRole('tablist', { name: 'Organization sections' });
const sectionNames = () => within(sectionList()).getAllByRole('tab').map((t) => t.textContent);
/** The cards on screen right now (the identity card is the real local one). */
const visibleCards = () => {
  const cards = ALL_CARDS.filter((c) => c !== 'identity' && screen.queryByText(`card:${c}`));
  return screen.queryByRole('button', { name: /save organization/i }) ? ['identity', ...cards] : cards;
};

beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  window.location.hash = '';
});
afterEach(() => { window.location.hash = ''; });

describe('Settings → Organization sections', () => {
  it('shows every section to a full admin, defaulting to General', async () => {
    as(ADMIN);
    query = { tab: 'organization' };
    render(<SettingsPage />);
    expect(sectionNames()).toEqual(['General', 'Security', 'Pipelines', 'AI', 'Data']);
    expect(within(sectionList()).getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('button', { name: /save organization/i });
    expect(visibleCards()).toEqual(['identity', 'domains', 'support']);
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('General');
  });

  it('groups each card under its section', () => {
    as(ADMIN);
    const expected: Record<string, string[]> = {
      security: ['mfa', 'password', 'authenticators', 'session', 'impersonation'],
      pipelines: ['runners', 'toolchain', 'plugin-security'],
      ai: ['ai'],
      data: ['export'],
    };
    for (const [section, cards] of Object.entries(expected)) {
      query = { tab: 'organization', section };
      render(<SettingsPage />);
      expect(visibleCards()).toEqual(cards);
      cleanup();
    }
  });

  it('hides sections with no visible card and defaults to the first visible one', () => {
    // A member with pipelines:read only: no General/Security/Data cards.
    as(['pipelines:read']);
    query = { tab: 'organization' };
    render(<SettingsPage />);
    expect(sectionNames()).toEqual(['Pipelines', 'AI']);
    expect(within(sectionList()).getByRole('tab', { name: 'Pipelines' })).toHaveAttribute('aria-selected', 'true');
    expect(visibleCards()).toEqual(['toolchain']);
  });

  it('falls back to the first visible section when the URL names one the viewer cannot see', () => {
    as(['pipelines:read']);
    query = { tab: 'organization', section: 'security' };
    render(<SettingsPage />);
    expect(within(sectionList()).getByRole('tab', { name: 'Pipelines' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a member without org_settings exactly the cards they saw before (across sections)', () => {
    // Before: toolchain (pipelines:read), plugin security (plugins:read), AI (always).
    as(['pipelines:read', 'plugins:read']);
    const seen: string[] = [];
    for (const section of ['general', 'security', 'pipelines', 'ai', 'data']) {
      query = { tab: 'organization', section };
      render(<SettingsPage />);
      seen.push(...visibleCards());
      cleanup();
    }
    expect([...new Set(seen)].sort()).toEqual(['ai', 'plugin-security', 'toolchain']);
  });

  it('shows the Security section to an impersonation-policy holder without org_settings', () => {
    as(['org_impersonation:write']);
    query = { tab: 'organization' };
    render(<SettingsPage />);
    expect(sectionNames()).toEqual(['Security', 'AI']);
    expect(visibleCards()).toEqual(['impersonation']);
  });

  it('writes ?section= on a switch, and arrow keys move between sections', () => {
    as(ADMIN);
    query = { tab: 'organization' };
    render(<SettingsPage />);
    fireEvent.click(within(sectionList()).getByRole('tab', { name: 'Security' }));
    expect(replace).toHaveBeenLastCalledWith({ query: { tab: 'organization', section: 'security' }, hash: '' }, undefined, { shallow: true });
    expect(visibleCards()).toEqual(['mfa', 'password', 'authenticators', 'session', 'impersonation']);

    fireEvent.keyDown(within(sectionList()).getByRole('tab', { name: 'Security' }), { key: 'ArrowRight' });
    expect(replace).toHaveBeenLastCalledWith({ query: { tab: 'organization', section: 'pipelines' }, hash: '' }, undefined, { shallow: true });
  });

  it('drops ?section= when leaving the Organization tab', () => {
    as(ADMIN);
    query = { tab: 'organization', section: 'security' };
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Profile' }));
    expect(replace).toHaveBeenLastCalledWith({ query: { tab: 'profile' }, hash: '' }, undefined, { shallow: true });
  });

  it('links SSO and incident reporting from an Integrations section, each behind its page gate', () => {
    // SSO rides `org_idp:write`; incident reporting is org-admin.
    as(['org_idp:write']);
    query = { tab: 'organization', section: 'integrations' };
    render(<SettingsPage />);
    expect(sectionNames()).toEqual(['AI', 'Integrations']);
    expect(screen.getByRole('link', { name: /single sign-on/i })).toHaveAttribute('href', '/dashboard/settings/sso');
    expect(screen.queryByRole('link', { name: /incident reporting/i })).not.toBeInTheDocument();
    cleanup();

    mockAuthGuard({
      user: { id: 'u1', organizationId: 'org-1', organizationName: 'Acme', username: 'u', email: 'u@acme.com', isEmailVerified: true, permissions: [] },
      can: () => false,
      isAdmin: true,
    });
    render(<SettingsPage />);
    expect(screen.getByRole('link', { name: /incident reporting/i })).toHaveAttribute('href', '/dashboard/settings/incident-reporting');
    expect(screen.queryByRole('link', { name: /single sign-on/i })).not.toBeInTheDocument();
    cleanup();

    // Neither: no Integrations section at all.
    as(['pipelines:read']);
    render(<SettingsPage />);
    expect(sectionNames()).not.toContain('Integrations');
  });

  it('gives each section a one-line description', () => {
    as(ADMIN);
    query = { tab: 'organization', section: 'security' };
    render(<SettingsPage />);
    expect(screen.getByTestId('org-section-description').textContent).toMatch(/sign/i);
  });
});

describe('deep links into the Organization sections', () => {
  it('builds every href with its section', () => {
    expect(DOMAIN_SETTINGS_HREF).toBe(`/dashboard/settings?tab=organization&section=general#${DOMAIN_SETTINGS_ANCHOR}`);
    expect(PIPELINE_RUNNERS_HREF).toBe(`/dashboard/settings?tab=organization&section=pipelines#${PIPELINE_RUNNERS_ANCHOR}`);
    expect(ORG_MFA_SETTINGS_HREF).toBe('/dashboard/settings?tab=organization&section=security');
    expect(orgSettingsHref('pipelines', PLUGIN_SECURITY_ANCHOR)).toBe('/dashboard/settings?tab=organization&section=pipelines#plugin-security');
  });

  it.each([
    [DOMAIN_SETTINGS_ANCHOR, 'General', 'domains'],
    [PIPELINE_RUNNERS_ANCHOR, 'Pipelines', 'runners'],
    [PLUGIN_SECURITY_ANCHOR, 'Pipelines', 'plugin-security'],
  ])('#%s alone opens the %s section and scrolls to the card', async (anchor, section, card) => {
    as(ADMIN);
    window.location.hash = `#${anchor}`;
    const { container } = render(<SettingsPage />);
    expect(within(sectionList()).getByRole('tab', { name: section })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(`card:${card}`)).toBeInTheDocument();
    expect(container.querySelector(`#${anchor}`)).not.toBeNull();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it.each([
    ['general', DOMAIN_SETTINGS_ANCHOR, 'General'],
    ['pipelines', PIPELINE_RUNNERS_ANCHOR, 'Pipelines'],
    ['pipelines', PLUGIN_SECURITY_ANCHOR, 'Pipelines'],
    ['security', '', 'Security'],
  ])('?section=%s#%s opens %s', (section, anchor, label) => {
    as(ADMIN);
    query = { tab: 'organization', section };
    window.location.hash = anchor ? `#${anchor}` : '';
    render(<SettingsPage />);
    expect(within(sectionList()).getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
  });
});

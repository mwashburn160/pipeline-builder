// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Organization mounts the Pipeline runners panel only for holders of
 * `org_settings:write` (never even reading it otherwise), and its fragment
 * (`#pipeline-runners`, the pipeline page's link) opens the Organization tab.
 * Runners are a core capability: no feature flag gates the panel, and it
 * renders nothing only while runners are unavailable on the deployment.
 */

import { describe, it, expect, jest, beforeEach, afterEach, beforeAll } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { PIPELINE_RUNNERS_ANCHOR } from '../src/lib/pipeline-runners';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/settings/ImpersonationPolicySettings', () => ({ ImpersonationPolicySettings: () => null }));
jest.mock('@/components/settings/MfaPolicySettings', () => ({ MfaPolicySettings: () => null }));
jest.mock('@/components/settings/PasswordPolicySettings', () => ({ PasswordPolicySettings: () => null }));
jest.mock('@/components/settings/AuthenticatorPolicySettings', () => ({ AuthenticatorPolicySettings: () => null }));
jest.mock('@/components/settings/SessionPolicySettings', () => ({ SessionPolicySettings: () => null }));
jest.mock('@/components/settings/DomainJoinSettings', () => ({ DomainJoinSettings: () => null }));
jest.mock('@/components/settings/SupportContactSettings', () => ({ SupportContactSettings: () => null }));
jest.mock('@/components/settings/PluginSecurityNotificationSettings', () => ({ PluginSecurityNotificationSettings: () => null }));
jest.mock('@/components/settings/OrgDataExport', () => ({ OrgDataExport: () => null }));
jest.mock('@/components/settings/AIProviderConfig', () => ({ AIProviderConfig: () => null }));
jest.mock('@/components/settings/PipelineToolchainSettings', () => ({ PipelineToolchainSettings: () => null }));
jest.mock('@/components/admin/StepUpModal', () => ({ StepUpModal: () => null }));
// No org features at all: the panel must not depend on any.
let mockFeatures = new Set<string>();
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({
    isEnabled: (f: string) => mockFeatures.has(f), features: [...mockFeatures], isLoaded: true, isSuperAdmin: false, canReachBilling: false,
    supportAlias: '', supportAliases: [], deployTarget: 'aws-ec2', adminConsolesEnabled: true, tierPresets: undefined,
    askUiMode: 'ask-agent', cliNpmPackage: 'pb-cli', cliNpmUrl: 'https://npm.example/pb-cli',
  }),
}));

const getPipelineRunners = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAccessToken: () => null,
    getMyOrganization: async () => ({ success: true, data: { organization: { id: 'org-1', name: 'Acme', slug: 'acme' } } }),
    getPipelineRunners: (...a: unknown[]) => getPipelineRunners(...a),
  },
}));

let query: Record<string, string> = {};
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query, pathname: '/dashboard/settings', replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() })));

import SettingsPage from '../pages/dashboard/settings';

beforeAll(() => { (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = jest.fn(); });

const admin = () => mockAuthGuard({
  user: { id: 'u1', organizationId: 'org-1', username: 'admin', email: 'a@acme.com', isEmailVerified: true, permissions: ['org_settings:write'] },
  can: (p: string) => p === 'org_settings:write',
});

beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  mockFeatures = new Set();
  window.location.hash = '';
  getPipelineRunners.mockResolvedValue({ success: true, data: { available: true, unavailableReason: null, platformEgressIps: null, own: [], inherited: [], signingKey: null } });
});
afterEach(() => { window.location.hash = ''; });

describe('Settings → Organization → Pipeline runners', () => {
  it('is shown to org_settings:write holders, and #pipeline-runners opens the tab', async () => {
    admin();
    window.location.hash = `#${PIPELINE_RUNNERS_ANCHOR}`;
    const { container } = render(<SettingsPage />);
    expect(await screen.findByText('Pipeline runners')).toBeInTheDocument();
    expect(container.querySelector(`#${PIPELINE_RUNNERS_ANCHOR}`)).not.toBeNull();
    expect(getPipelineRunners).toHaveBeenCalled();
  });

  it('is hidden — and never read — without org_settings:write', async () => {
    mockAuthGuard({
      user: { id: 'u2', organizationId: 'org-1', username: 'dev', email: 'd@acme.com', isEmailVerified: true, permissions: ['pipelines:read'] },
      can: (p: string) => p === 'pipelines:read',
    });
    query = { tab: 'organization' };
    render(<SettingsPage />);
    await waitFor(() => expect(screen.queryByText('Pipeline runners')).not.toBeInTheDocument());
    expect(getPipelineRunners).not.toHaveBeenCalled();
  });

  it('is shown to an admin whose org has no features at all (no cross_account_runners gate)', async () => {
    admin();
    mockFeatures = new Set();
    query = { tab: 'organization' };
    const { container } = render(<SettingsPage />);
    expect(await screen.findByText('Pipeline runners')).toBeInTheDocument();
    expect(container.querySelector(`#${PIPELINE_RUNNERS_ANCHOR}`)).not.toBeNull();
    expect(getPipelineRunners).toHaveBeenCalled();
  });

  it('renders nothing while runners are unavailable (paused)', async () => {
    admin();
    query = { tab: 'organization' };
    getPipelineRunners.mockResolvedValue({ success: true, data: { available: false, unavailableReason: 'paused', platformEgressIps: null, own: [], inherited: [], signingKey: null } });
    render(<SettingsPage />);
    await waitFor(() => expect(getPipelineRunners).toHaveBeenCalled());
    expect(screen.queryByText('Pipeline runners')).not.toBeInTheDocument();
  });
});

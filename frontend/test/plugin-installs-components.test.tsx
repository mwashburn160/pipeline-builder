// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * W2 install surfaces: the shared install controls (every state and the calls
 * they make), the consumption-policy tab (read-only vs editable, inheritance,
 * step-up save of only the changed fields), the approvals tab and the catalog.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { POLICY, catalogEntry, installView, officialEntry } from './helpers/pluginInstallFixtures';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => toast }));

let stepUpToken = 'tok';
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button type="button" data-testid="stepup-confirm" onClick={() => onConfirmed(stepUpToken)}>confirm step-up</button>
  ),
}));
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => ({ isReady: true, query: {}, replace: jest.fn(), push: jest.fn() }) }));

const api = {
  createPluginInstall: jest.fn<AnyFn>(),
  updatePluginInstall: jest.fn<AnyFn>(),
  deletePluginInstall: jest.fn<AnyFn>(),
  approvePluginInstall: jest.fn<AnyFn>(),
  denyPluginInstall: jest.fn<AnyFn>(),
  listPluginInstalls: jest.fn<AnyFn>(),
  getInstallPolicy: jest.fn<AnyFn>(),
  updateInstallPolicy: jest.fn<AnyFn>(),
  getListingInstallState: jest.fn<AnyFn>(),
  getPluginCatalog: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import { InstallControls } from '../src/components/plugin-installs/InstallControls';
import { PolicyTab } from '../src/components/plugin-installs/PolicyTab';
import { ApprovalsTab } from '../src/components/plugin-installs/ApprovalsTab';
import { CatalogTab } from '../src/components/plugin-installs/CatalogTab';
import { InstallsTab } from '../src/components/plugin-installs/InstallsTab';

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });

beforeEach(() => {
  jest.clearAllMocks();
  stepUpToken = 'tok';
  api.getListingInstallState.mockReturnValue(ok({ versions: [
    { version: '1.2.0', breaking: false, yanked: false, paused: false, deprecated: false, publishedAt: '', changelog: null, vulnCritical: 0, vulnHigh: 0 },
    { version: '1.1.0', breaking: false, yanked: true, paused: false, deprecated: false, publishedAt: '', changelog: null, vulnCritical: 0, vulnHigh: 0 },
  ] }));
});

describe('InstallControls', () => {
  it('installs, and reports a pending request when approval is required', async () => {
    const onChanged = jest.fn<AnyFn>();
    api.createPluginInstall.mockReturnValue(ok({ install: installView({ status: 'pending_approval' }) }));
    render(<InstallControls entry={catalogEntry({ requiresApproval: true })} canInstall onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request install' }));
    expect(await screen.findByRole('status')).toHaveTextContent('An approver in your organization has been notified');
    expect(api.createPluginInstall).toHaveBeenCalledWith({ publisher: 'acme', name: 'terraform-plan' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the server message when an install is refused', async () => {
    api.createPluginInstall.mockRejectedValue(new Error("Your organization's plugin policy doesn't allow community plugins"));
    render(<InstallControls entry={catalogEntry()} canInstall onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't allow community plugins");
  });

  it('without plugins:install, explains instead of offering the button', () => {
    render(<InstallControls entry={catalogEntry()} canInstall={false} onChanged={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.getByText(/Install plugins permission/)).toBeInTheDocument();
  });

  it('implicit Official: labelled, and pinning creates an explicit install', async () => {
    api.createPluginInstall.mockReturnValue(ok({ install: installView() }));
    render(<InstallControls entry={officialEntry()} canInstall onChanged={() => undefined} />);
    expect(screen.getByText(/Installed automatically \(Official\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pin or change policy' }));
    const dialog = await screen.findByRole('dialog');
    // Yanked versions are not offered.
    await waitFor(() => expect(within(dialog).getByRole('option', { name: '1.2.0' })).toBeInTheDocument());
    expect(within(dialog).queryByRole('option', { name: /1\.1\.0/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Version policy'), { target: { value: 'pinned' } });
    fireEvent.change(within(dialog).getByLabelText('Baseline version'), { target: { value: '1.2.0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create install' }));
    await waitFor(() => expect(api.createPluginInstall).toHaveBeenCalledWith({
      publisher: 'pipeline-builder', name: 'trivy', versionPolicy: 'pinned', version: '1.2.0',
    }));
  });

  it('installed: upgrade (with changelog + vuln delta), change policy and uninstall', async () => {
    const install = installView({ upgrade: { version: '2.0.0', breaking: true, changelog: 'Drops v1 flags', vulnDelta: { newCritical: 1, newHigh: 2 } } });
    api.updatePluginInstall.mockReturnValue(ok({ install }));
    api.deletePluginInstall.mockReturnValue(ok({ removed: true, implicitFallback: false }));
    render(<InstallControls entry={catalogEntry({ install })} canInstall onChanged={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /Upgrade to 2.0.0/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('marked this version as breaking');
    expect(dialog).toHaveTextContent('1 critical and 2 high');
    expect(dialog).toHaveTextContent('Drops v1 flags');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upgrade' }));
    await waitFor(() => expect(api.updatePluginInstall).toHaveBeenCalledWith('i1', { version: '2.0.0' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(api.deletePluginInstall).toHaveBeenCalledWith('i1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Uninstalled.');
  });

  it('pending: withdraw; inherited installs are read-only', async () => {
    api.deletePluginInstall.mockReturnValue(ok({ removed: true, implicitFallback: false }));
    const { unmount } = render(<InstallControls entry={catalogEntry({ install: installView({ status: 'pending_approval' }) })} canInstall onChanged={() => undefined} />);
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(api.deletePluginInstall).toHaveBeenCalledWith('i1'));
    unmount();

    render(<InstallControls entry={catalogEntry({ install: installView({ inherited: true }) })} canInstall onChanged={() => undefined} />);
    expect(screen.getByText(/from your root organization/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull();
  });

  it('blocked, paused and denied show their reason', () => {
    const { rerender } = render(<InstallControls entry={catalogEntry({ installable: false, blocked: { reason: 'advisory', message: 'Blocked by advisory PBSA-1' } })} canInstall onChanged={() => undefined} />);
    expect(screen.getByText('Blocked by advisory PBSA-1')).toBeInTheDocument();
    rerender(<InstallControls entry={catalogEntry({ installable: false, listing: { ...catalogEntry().listing, paused: true } })} canInstall onChanged={() => undefined} />);
    expect(screen.getByText(/Paused by the publisher/)).toBeInTheDocument();
    rerender(<InstallControls entry={catalogEntry({ install: installView({ status: 'denied' }) })} canInstall onChanged={() => undefined} />);
    expect(screen.getByText('Install request denied')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove request' })).toBeInTheDocument();
  });
});

function policyResponse(over: Record<string, unknown> = {}) {
  return { policy: POLICY, effective: POLICY, inheritsFromRoot: false, updatedBy: null, updatedAt: null, canEdit: true, ...over };
}

describe('PolicyTab', () => {
  it('is read-only without plugin_installs:manage', async () => {
    api.getInstallPolicy.mockReturnValue(ok(policyResponse({ canEdit: false })));
    render(<PolicyTab canManage={false} />);
    expect(await screen.findByText(/Only members with the Manage plugin installs permission/)).toBeInTheDocument();
    expect(screen.getByLabelText('Allowed publisher tiers: Official')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
  });

  it('shows inheritance and the effective policy for a team', async () => {
    api.getInstallPolicy.mockReturnValue(ok(policyResponse({ inheritsFromRoot: true, effective: { ...POLICY, allowedTiers: ['official'] } })));
    render(<PolicyTab canManage />);
    expect(await screen.findByText('Inherited from your root organization')).toBeInTheDocument();
    expect(screen.getByTestId('effective-policy')).toHaveTextContent('Allowed tiers' + 'Official');
  });

  it('saves only the changed fields, through step-up', async () => {
    api.getInstallPolicy.mockReturnValue(ok(policyResponse()));
    api.updateInstallPolicy.mockReturnValue(ok(policyResponse({ policy: { ...POLICY, blockOnAdvisory: 'high' } })));
    render(<PolicyTab canManage />);
    const save = await screen.findByRole('button', { name: 'Save policy' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Block on security advisory'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Block a listing'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(screen.getByText(/Enter a listing as publisher\/name/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Block a listing'), { target: { value: 'acme/tf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(screen.getByRole('list', { name: 'Blocked listings' })).toHaveTextContent('acme/tf');

    fireEvent.click(save);
    fireEvent.click(screen.getByTestId('stepup-confirm'));
    await waitFor(() => expect(api.updateInstallPolicy).toHaveBeenCalledWith(
      { blockOnAdvisory: 'high', blockedListings: [{ publisher: 'acme', name: 'tf' }] }, 'tok',
    ));
    expect(toast.success).toHaveBeenCalled();
  });

  it('warns before turning off implicit Official installs', async () => {
    api.getInstallPolicy.mockReturnValue(ok(policyResponse()));
    render(<PolicyTab canManage />);
    fireEvent.change(await screen.findByLabelText('Official plugins'), { target: { value: 'explicit' } });
    expect(screen.getByText(/installed deliberately: pipelines/)).toBeInTheDocument();
  });
});

describe('ApprovalsTab', () => {
  it('approves and denies pending requests (with a reason)', async () => {
    api.listPluginInstalls.mockReturnValue(ok({ installs: [installView({ status: 'pending_approval' }), installView({ id: 'i2', name: 'other', status: 'pending_approval' })], policy: POLICY }));
    api.approvePluginInstall.mockReturnValue(ok({ install: installView() }));
    api.denyPluginInstall.mockReturnValue(ok({ install: installView({ status: 'denied' }) }));
    render(<ApprovalsTab />);
    const rows = await screen.findAllByTestId('approval-row');
    expect(api.listPluginInstalls).toHaveBeenCalledWith({ status: 'pending_approval' }, expect.anything());
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(api.approvePluginInstall).toHaveBeenCalledWith('i1'));

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Deny' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'unvetted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(api.denyPluginInstall).toHaveBeenCalledWith('i2', 'unvetted'));
  });

  it('empty state', async () => {
    api.listPluginInstalls.mockReturnValue(ok({ installs: [], policy: POLICY }));
    render(<ApprovalsTab />);
    expect(await screen.findByText('No pending install requests')).toBeInTheDocument();
  });
});

describe('CatalogTab and InstallsTab', () => {
  it('lists catalog entries with tier, reference and usage, and filters by category', async () => {
    api.getPluginCatalog.mockReturnValue(ok({ listings: [officialEntry('trivy'), catalogEntry()] }));
    render(<CatalogTab canInstall usage={{ trivy: 2, 'acme/terraform-plan': 1 }} initialQuery="t" />);
    const cards = await screen.findAllByTestId('catalog-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('Reference: trivy');
    expect(cards[0]).toHaveTextContent('used by 2 pipelines');
    expect(cards[1]).toHaveTextContent('Reference: acme/terraform-plan');
    expect(cards[1].querySelector('[data-tier="verified"]')).not.toBeNull();
    expect(api.getPluginCatalog).toHaveBeenCalledWith({ q: 't', category: undefined, installed: undefined }, expect.anything());

    fireEvent.change(screen.getByLabelText('Catalog category'), { target: { value: 'security' } });
    fireEvent.change(screen.getByLabelText('Install state'), { target: { value: 'installed' } });
    await waitFor(() => expect(api.getPluginCatalog).toHaveBeenLastCalledWith({ q: 't', category: 'security', installed: true }, expect.anything()));
  });

  it('shows the review score, vote count and install count on a catalog card', async () => {
    api.getPluginCatalog.mockReturnValue(ok({ listings: [
      catalogEntry({ rating: { score: 4.3, count: 27 }, installCount: 1520 }),
      catalogEntry({ listing: { ...catalogEntry().listing, id: 'l2', name: 'unrated' } }),
    ] }));
    render(<CatalogTab canInstall usage={{}} />);
    const cards = await screen.findAllByTestId('catalog-card');
    const stats = within(cards[0]).getByTestId('catalog-stats');
    expect(stats).toHaveTextContent('4.3 out of 5 (27 ratings)');
    expect(stats).toHaveTextContent('1.5k installs');
    // Unrated and never installed: no stats row at all.
    expect(within(cards[1]).queryByTestId('catalog-stats')).toBeNull();
  });

  it('installs tab asks for implicit Official installs on demand', async () => {
    api.listPluginInstalls.mockReturnValue(ok({ installs: [installView({ upgrade: { version: '2.0.0', breaking: false, changelog: null, vulnDelta: { newCritical: 0, newHigh: 0 } } })], policy: POLICY }));
    render(<InstallsTab canInstall usage={{}} />);
    const row = await screen.findByTestId('install-row');
    expect(row).toHaveTextContent('acme/terraform-plan');
    expect(row).toHaveTextContent('Upgrade available: v2.0.0');
    expect(api.listPluginInstalls).toHaveBeenLastCalledWith({ status: 'all', implicit: false }, expect.anything());
    fireEvent.click(screen.getByLabelText('Show automatic Official installs'));
    await waitFor(() => expect(api.listPluginInstalls).toHaveBeenLastCalledWith({ status: 'all', implicit: true }, expect.anything()));
  });
});

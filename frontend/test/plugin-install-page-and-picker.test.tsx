// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * W2 wiring outside the plugins dashboard: the public plugin page shows the
 * signed-in org's install state (and stays the guest page signed out), and the
 * pipeline editor's plugin picker offers own plugins AND resolvable catalog
 * listings, writes `publisher` for a listing, and warns about shadowed names.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { detail } from './helpers/publicDirectoryFixtures';
import { catalogEntry, installView, officialEntry } from './helpers/pluginInstallFixtures';

jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: {}, asPath: '/plugins/pipeline-builder/trivy', pathname: '/plugins', push: jest.fn(), replace: jest.fn() }),
}));
let authState: Record<string, unknown> = { user: null, isAuthenticated: false, isInitialized: true };
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => authState }));
jest.mock('@/hooks/useDarkMode', () => ({ __esModule: true, useDarkMode: () => ({ isDark: false, toggle: () => undefined }) }));
jest.mock('@/generated/plugin-icons', () => ({ __esModule: true, PLUGIN_ICONS: {} }));

const api = {
  getListingInstallState: jest.fn<AnyFn>(),
  listPlugins: jest.fn<AnyFn>(),
  getAllPluginCatalog: jest.fn<AnyFn>(),
  getPluginShadowing: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import PluginPage from '../pages/plugins/[publisher]/[name]';
import PluginOptionsEditor from '../src/components/pipeline/editors/PluginOptionsEditor';
import { clearPluginCache } from '../src/hooks/usePlugins';
import { createEmptyPlugin, type FormPluginOptions } from '../src/types/form-types';

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });

beforeEach(() => {
  jest.clearAllMocks();
  clearPluginCache();
  authState = { user: null, isAuthenticated: false, isInitialized: true };
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

describe('public plugin page install action', () => {
  it('signed out: the guest affordance, no API call', () => {
    render(<PluginPage siteUrl="https://pb.example" listing={detail()} tab="overview" />);
    expect(screen.getByRole('link', { name: 'Sign in to install' })).toBeInTheDocument();
    expect(screen.getByText(/no install needed/)).toBeInTheDocument();
    expect(api.getListingInstallState).not.toHaveBeenCalled();
  });

  it('signed in: the org install state for this listing', async () => {
    authState = { user: { id: 'u1', username: 'dana', email: 'd@x' }, isAuthenticated: true, isInitialized: true };
    api.getListingInstallState.mockReturnValue(ok({ entry: officialEntry('trivy'), versions: [], canInstall: true, canManage: false }));
    render(<PluginPage siteUrl="https://pb.example" listing={detail()} tab="overview" />);
    expect(await screen.findByText(/Installed automatically \(Official\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pin or change policy' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in to install' })).toBeNull();
    expect(api.getListingInstallState).toHaveBeenCalledWith('pipeline-builder', 'trivy', expect.anything());
  });

  it('signed in but the state is unreadable: falls back to the catalog link', async () => {
    authState = { user: { id: 'u1', username: 'dana', email: 'd@x' }, isAuthenticated: true, isInitialized: true };
    api.getListingInstallState.mockRejectedValue(new Error('down'));
    render(<PluginPage siteUrl="https://pb.example" listing={detail()} tab="overview" />);
    expect(await screen.findByRole('link', { name: 'Open in your catalog' })).toHaveAttribute('href', '/dashboard/plugins?tab=catalog&q=trivy');
  });
});

function Harness({ initial, onValue }: { initial: FormPluginOptions; onValue: (v: FormPluginOptions) => void }) {
  const [value, setValue] = useState(initial);
  return <PluginOptionsEditor value={value} onChange={(v) => { setValue(v); onValue(v); }} />;
}

describe('pipeline editor plugin picker', () => {
  const acme = catalogEntry({
    install: installView(),
    resolved: { ...officialEntry().resolved!, version: '1.2.0' },
  });
  const notInstalled = catalogEntry({ listing: { ...catalogEntry().listing, id: 'l9', name: 'not-installed' } });

  beforeEach(() => {
    api.listPlugins.mockReturnValue(ok({ plugins: [{ id: 'p1', orgId: 'org-1', name: 'my-build', version: '1.0.0', category: 'build', visibility: 'org', isDefault: true, isActive: true }] }));
    api.getAllPluginCatalog.mockResolvedValue([officialEntry('trivy'), acme, notInstalled]);
    api.getPluginShadowing.mockReturnValue(ok({ shadowing: [{ name: 'my-build', pluginIds: ['p1'], listing: { publisherHandle: 'pipeline-builder', name: 'my-build', publisherTier: 'official' } }] }));
  });

  it('offers own plugins and resolvable listings; picking a listing writes publisher + name', async () => {
    const onValue = jest.fn<AnyFn>();
    render(<Harness initial={createEmptyPlugin()} onValue={onValue} />);
    fireEvent.focus(screen.getByPlaceholderText('plugin-name (type or select)'));
    const option = await screen.findByRole('option', { name: /terraform-plan/ });
    expect(screen.getByRole('option', { name: /my-build/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /trivy/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /not-installed/ })).toBeNull();
    expect(screen.getByText('Installed from the catalog')).toBeInTheDocument();

    fireEvent.click(option);
    await waitFor(() => expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ publisher: 'acme', name: 'terraform-plan' })));
    const last = onValue.mock.calls.at(-1)![0] as FormPluginOptions;
    expect(last.filter.id).toBe('');
    expect(screen.getByText('acme/')).toBeInTheDocument();
  });

  it('picking an Official listing writes the bare name; an own plugin clears the publisher', async () => {
    const onValue = jest.fn<AnyFn>();
    render(<Harness initial={{ ...createEmptyPlugin(), publisher: 'acme', name: 'x' }} onValue={onValue} />);
    const input = screen.getByPlaceholderText('plugin-name (type or select)');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'trivy' } });
    fireEvent.click(await screen.findByRole('option', { name: /trivy/ }));
    await waitFor(() => expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ publisher: '', name: 'trivy' })));
  });

  it('warns when an unqualified name is shadowed by an own plugin', async () => {
    render(<Harness initial={{ ...createEmptyPlugin(), name: 'my-build' }} onValue={() => undefined} />);
    expect(await screen.findByTestId('shadowing-notice')).toHaveTextContent('Shadows the Official listing pipeline-builder/my-build');
  });
});

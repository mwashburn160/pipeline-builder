// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin "create as team": the parent picker offers only ELIGIBLE parents —
 * top-level orgs on the team or enterprise tier — found by a server-side search
 * rather than a capped client list.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateOrganizationFlow } from '../src/components/organizations/CreateOrganizationFlow';

const listOrganizations = jest.fn<AnyFn>();
const createOrganization = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listOrganizations: (...a: unknown[]) => listOrganizations(...a),
    createOrganization: (...a: unknown[]) => createOrganization(...a),
  },
}));
jest.mock('@/lib/api-cache', () => ({ __esModule: true, invalidate: { organizations: jest.fn<AnyFn>() } }));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));
jest.mock('@/components/onboarding/OrgSetupStep', () => ({ __esModule: true, OrgSetupStep: () => null }));
// Search immediately — the debounce is not what's under test.
jest.mock('@/hooks/useDebounce', () => ({ __esModule: true, useDebounce: (v: unknown) => v }));

const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, ownerId: 'u', memberCount: 1, createdAt: '', updatedAt: '', parentOrgId: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  listOrganizations.mockImplementation(async (params: { tier: string }) => ({
    success: true,
    data: {
      organizations: params.tier === 'team'
        ? [row('r-team', 'Beta Team Root', { tier: 'team' }), row('t-1', 'Nested Team', { tier: 'team', parentOrgId: 'r-team' })]
        : [row('r-ent', 'Acme Enterprise', { tier: 'enterprise' }), row('r-gone', 'Deleted Root', { tier: 'enterprise', pendingDeletion: true })],
      pagination: { total: 2, offset: 0, limit: 20, hasMore: false },
    },
  }));
  createOrganization.mockResolvedValue({ success: true, data: { organization: { id: 'new' } } });
});

function openAsTeam() {
  render(<CreateOrganizationFlow open onClose={jest.fn<AnyFn>()} onCreated={jest.fn<AnyFn>()} />);
  fireEvent.click(screen.getByRole('checkbox'));
}

describe('CreateOrganizationFlow — eligible parents', () => {
  it('queries only the team and enterprise tiers, server-side', async () => {
    openAsTeam();
    fireEvent.focus(screen.getByRole('combobox', { name: 'Parent organization' }));
    await screen.findByRole('option', { name: /acme enterprise/i });
    const tiers = listOrganizations.mock.calls.map((call: unknown[]) => (call[0] as { tier: string }).tier).sort();
    expect(tiers).toEqual(['enterprise', 'team']);
  });

  it('offers top-level, live roots only — never a team or a soft-deleted org', async () => {
    openAsTeam();
    fireEvent.focus(screen.getByRole('combobox', { name: 'Parent organization' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Acme Enterpriseenterprise', 'Beta Team Rootteam']);
  });

  it('passes the typed text to the server search', async () => {
    openAsTeam();
    const box = screen.getByRole('combobox', { name: 'Parent organization' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'acme' } });
    await waitFor(() => expect(listOrganizations).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'acme', tier: 'enterprise' }), expect.anything(),
    ));
  });

  it('creates the team under the picked parent without sending a tier', async () => {
    openAsTeam();
    fireEvent.change(screen.getByPlaceholderText('e.g. acme-platform'), { target: { value: 'platform' } });
    // A team inherits its parent's tier, so the tier picker is gone.
    expect(screen.queryByText('Tier')).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole('combobox', { name: 'Parent organization' }));
    fireEvent.click(await screen.findByRole('option', { name: /acme enterprise/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await waitFor(() => expect(createOrganization).toHaveBeenCalledWith({ name: 'platform', parentOrgId: 'r-ent' }));
  });
});

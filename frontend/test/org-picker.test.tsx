// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org pickers used to be `<select>`s over the first 100 orgs of the fleet:
 * past that cap an org could not be chosen, and a user already IN one showed a
 * blank select — saving then quietly moved them out. The replacement searches
 * on the server and always keeps the current value as an option.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listOrganizations = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const api = { listOrganizations: (...a: unknown[]) => listOrganizations(...a) };
  return { __esModule: true, default: api, api };
});

import { OrgPicker } from '../src/components/ui/OrgPicker';
import { clearQueryCache } from '../src/lib/query-cache';

const FAR = 'f'.repeat(24); // an org well past any first page
const NEAR = 'a'.repeat(24);

beforeEach(() => {
  jest.clearAllMocks();
  clearQueryCache();
  listOrganizations.mockImplementation(async (params: { ids?: string; search?: string }) => {
    if (params.ids) return { success: true, data: { organizations: [{ id: FAR, name: 'Far Away Ltd' }] } };
    const all = [{ id: NEAR, name: 'Acme' }];
    return { success: true, data: { organizations: all.filter((o) => !params.search || o.name.toLowerCase().includes(params.search.toLowerCase())) } };
  });
});

describe('OrgPicker', () => {
  it('names the current value even when no search page contains it', async () => {
    render(<OrgPicker value={FAR} onChange={jest.fn<AnyFn>()} none={{ value: '', label: '— No organization —' }} aria-label="Organization" />);
    await waitFor(() => expect(screen.getByLabelText('Organization')).toHaveValue('Far Away Ltd'));
    expect(listOrganizations).toHaveBeenCalledWith(expect.objectContaining({ ids: FAR }), expect.anything());
  });

  it('keeps the current value as an option alongside the search results', async () => {
    render(<OrgPicker value={FAR} onChange={jest.fn<AnyFn>()} valueName="Far Away Ltd" aria-label="Organization" />);
    fireEvent.focus(screen.getByLabelText('Organization'));
    expect(await screen.findByRole('option', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Far Away Ltd' })).toHaveAttribute('aria-selected', 'true');
  });

  it('searches on the server as you type and selects by id', async () => {
    const onChange = jest.fn<AnyFn>();
    render(<OrgPicker value="all" onChange={onChange} none={{ value: 'all', label: 'All organizations' }} aria-label="Organization" />);
    const input = screen.getByLabelText('Organization');
    expect(input).toHaveValue('All organizations');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'acm' } });
    await waitFor(() => expect(listOrganizations).toHaveBeenCalledWith(expect.objectContaining({ search: 'acm' }), expect.anything()));
    fireEvent.click(await screen.findByRole('option', { name: 'Acme' }));
    expect(onChange).toHaveBeenCalledWith(NEAR);
  });
});

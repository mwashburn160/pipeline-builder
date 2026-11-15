// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * useMemberTeams: only the latest "Manage teams" open may publish its roster.
 * Closing one member's modal and opening another's while the first read is in
 * flight must never show — or save a diff against — the first member's teams.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMemberTeams } from '../src/hooks/useMemberTeams';
import type { OrganizationMember } from '../src/types';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));

const getMemberTeams = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getMemberTeams: (...a: unknown[]) => getMemberTeams(...a) },
}));

const member = (id: string) => ({ id, username: id }) as unknown as OrganizationMember;
const teams = (orgId: string) => ({ success: true, data: { teams: [{ orgId, orgName: orgId, isMember: true, role: 'member' }] } });

beforeEach(() => { getMemberTeams.mockReset(); });

describe('useMemberTeams', () => {
  it('drops a superseded roster read', async () => {
    let releaseFirst: (v: unknown) => void = () => undefined;
    getMemberTeams.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));
    getMemberTeams.mockImplementationOnce(() => Promise.resolve(teams('team-b')));
    const { result } = renderHook(() => useMemberTeams({ orgId: 'org-1' }));

    act(() => { void result.current.openManageTeams(member('alice')); });
    act(() => result.current.closeManageTeams());
    await act(async () => { await result.current.openManageTeams(member('bob')); });
    await act(async () => { releaseFirst(teams('team-a')); });

    expect(result.current.manageTeamsTarget?.id).toBe('bob');
    expect(result.current.teamRoster.map((t) => t.orgId)).toEqual(['team-b']);
    expect([...result.current.selectedTeamIds]).toEqual(['team-b']);
    expect(result.current.teamsLoading).toBe(false);
  });

  it('shows the server message when the roster read fails', async () => {
    getMemberTeams.mockRejectedValue(new Error('Not a member of this organization'));
    const { result } = renderHook(() => useMemberTeams({ orgId: 'org-1' }));
    await act(async () => { await result.current.openManageTeams(member('alice')); });
    await waitFor(() => expect(result.current.teamsError).toBe('Not a member of this organization'));
  });
});

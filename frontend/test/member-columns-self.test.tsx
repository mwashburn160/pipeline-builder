// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform refuses to let a member deactivate (or remove) their own
 * membership (400 "Cannot deactivate yourself"), so the roster must not offer
 * those actions on the caller's own row.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { buildMemberColumns } from '../src/components/members/memberColumns';
import type { OrganizationMember } from '../src/types';

function member(id: string, username: string): OrganizationMember {
  return {
    id, username, email: `${username}@example.test`, role: 'member', isOwner: false,
    isActive: true, isEmailVerified: true, joinedAt: '2026-01-01T00:00:00.000Z',
  } as OrganizationMember;
}

function renderActions(m: OrganizationMember) {
  const cols = buildMemberColumns({
    currentUserId: 'me',
    canTransferOwnership: true,
    canManageMembers: true,
    canManageTeams: true,
    canManageRoles: true,
    rolesForMember: () => [],
    onManageTeams: jest.fn(), onTransfer: jest.fn(), onManageRoles: jest.fn(),
    onToggleActive: jest.fn(), onRemove: jest.fn(), onResetMfa: jest.fn(),
  });
  const actions = cols.find((c) => c.id === 'actions')!;
  return render(<div>{actions.render!(m, 0)}</div>);
}

describe('member roster row actions', () => {
  it('offers Deactivate and Remove on another member', () => {
    renderActions(member('u2', 'alice'));
    expect(screen.getByRole('button', { name: 'Deactivate alice' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove alice from the organization' })).toBeTruthy();
  });

  it('offers no Deactivate (or Remove) on the caller’s own row', () => {
    renderActions(member('me', 'myself'));
    expect(screen.queryByRole('button', { name: 'Deactivate myself' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove myself/ })).toBeNull();
  });
});

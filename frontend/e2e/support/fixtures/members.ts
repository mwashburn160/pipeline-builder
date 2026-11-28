// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Members page stub data: an org (`org-1`, "Acme") with three members, one
 * team, the seeded Roles plus a custom one, and two invitations (one pending,
 * one accepted). `stubMembers(api)` registers every read the four tabs make
 * and the invitation writes, keeping the invitation list stateful so a send
 * or a revoke shows up on the next read.
 */

import { OWNER, ok, type Backend, type StubUser } from '../backend';

export const ORG = 'org-1';
export const TEAM_ID = 'org-team-1';

/** OWNER, with the org parenting one team (so the Teams tab has rows). */
export const OWNER_WITH_TEAM: StubUser = {
  ...OWNER,
  organizations: [
    { ...OWNER.organizations[0], childOrgCount: 1 },
  ],
};

const member = (id: string, username: string, role: string, roles: Array<{ id: string; name: string }>, extra: Record<string, unknown> = {}) => ({
  id, username, email: `${username}@example.test`, role, isOwner: role === 'owner', isActive: true, isEmailVerified: true,
  joinedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:00Z', roles, ...extra,
});

export const ROLES = [
  { id: 'role-admin', name: 'Administrators', description: 'Full administration', grantsRole: 'admin', permissions: ['members:manage'], system: true, members: [{ id: 'u-1', username: 'dana', email: 'dana@example.test' }] },
  { id: 'role-dev', name: 'Developers', description: 'Build pipelines', grantsRole: 'member', permissions: ['pipelines:write'], system: true, members: [{ id: 'u-2', username: 'eli', email: 'eli@example.test' }] },
  { id: 'role-release', name: 'Release managers', description: 'Ship to production', grantsRole: 'member', permissions: ['pipelines:read', 'pipelines:write'], system: false, members: [] },
];

export const MEMBERS = [
  member('u-1', 'dana', 'owner', [{ id: 'role-admin', name: 'Administrators' }]),
  member('u-2', 'eli', 'member', [{ id: 'role-dev', name: 'Developers' }]),
  member('u-3', 'fran', 'admin', [], { isActive: false }),
];

export const TEAMS = [{ orgId: TEAM_ID, orgName: 'Payments team', parentOrgId: ORG }];

const invitation = (id: string, email: string, status: string) => ({
  id, email, role: 'member', status, invitedBy: 'u-1', inviterName: 'dana', organizationId: ORG,
  expiresAt: '2026-12-10T00:00:00Z', createdAt: '2026-11-20T00:00:00Z',
});

export function stubMembers(api: Backend) {
  const invitations = [
    invitation('inv-1', 'gale@example.test', 'pending'),
    invitation('inv-2', 'hal@example.test', 'accepted'),
  ];
  const page = (rows: unknown[]) => ({ total: rows.length, offset: 0, limit: 25, hasMore: false });
  api.on(`GET /api/organization/${ORG}/members`, () => ok({ members: MEMBERS, pagination: page(MEMBERS) }));
  api.on(`GET /api/organization/${ORG}/roles`, () => ok({ roles: ROLES, pagination: page(ROLES) }));
  api.on(`GET /api/organization/${ORG}/seat-usage`, ok({ limit: 25, used: 4, tier: 'pro' }));
  api.on(`GET /api/organization/${ORG}/mfa-resets`, ok({ requests: [] }));
  api.on(`GET /api/organization/${ORG}/teams`, ok({ teams: TEAMS }));
  api.on(`GET /api/organization/${ORG}/teams/deleted`, ok({ teams: [] }));
  // The team-access picker lists the selected team's roster.
  api.on(`GET /api/organization/${TEAM_ID}/members`, ok({ members: [], pagination: page([]) }));
  api.on('GET /api/invitation', () => ok({ invitations, pagination: page(invitations) }));
  api.on('POST /api/invitation/send', (call) => {
    const { emails } = call.json as { emails: string[] };
    emails.forEach((email, i) => invitations.unshift(invitation(`inv-new-${i}`, email, 'pending')));
    return ok({ sent: emails.map((email) => ({ email, delivery: 'sent' })), failed: [] });
  });
  api.on('DELETE /api/invitation/inv-1', () => {
    const row = invitations.find((i) => i.id === 'inv-1');
    if (row) row.status = 'revoked';
    return ok({ message: 'Invitation revoked' });
  });
  return { invitations };
}

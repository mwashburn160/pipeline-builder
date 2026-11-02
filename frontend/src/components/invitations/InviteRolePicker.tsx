// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import Link from 'next/link';
import { Checkbox } from '@/components/ui/Checkbox';
import { useFetch } from '@/hooks/useFetch';
import { api } from '@/lib/api';
import type { OrganizationRole } from '@/types';

interface InviteRolePickerProps {
  /** The org the invitation targets — Roles are org-scoped. */
  orgId: string | undefined;
  /** Currently selected Role ids. */
  value: string[];
  onChange: (roleIds: string[]) => void;
  disabled?: boolean;
}

/**
 * Pick the Roles an invitation grants on acceptance.
 *
 * THE GAP THIS CLOSES. An invitation used to carry only the coarse
 * `admin | member` word, so onboarding anyone into a job — Developer, Billing
 * Manager, Security Officer — meant one of two bad shapes: invite them as ADMIN
 * (every org-assignable permission, `roles:manage` and `org_kms:write`
 * included) and demote afterwards, or invite as member and remember to assign
 * the Role later. The first hands over the keys; the second leaves a window
 * where they can do nothing. The user-admin API has taken `roleIds` all along —
 * the invitation was the path that had not.
 *
 * WHAT IS NOT OFFERED. The **Super Admin** Role: granting the platform flag
 * goes through a step-up earned by a second factor, and an invitation is a
 * bearer token delivered by email. The server refuses it outright
 * (`RL_SUPERADMIN_ROLE_NOT_INVITABLE`); hiding it here just avoids presenting a
 * control that cannot work. The server ALSO bounds the selection by the
 * inviter's own ceiling and re-checks it at acceptance, so this list being
 * generous is not what decides the grant.
 */
export function InviteRolePicker({ orgId, value, onChange, disabled }: InviteRolePickerProps) {
  const roles = useFetch<OrganizationRole[]>(async (signal) => {
    if (!orgId) return [];
    try {
      const res = await api.getOrganizationRoles(orgId, { limit: 100 }, { signal });
      return res.data?.roles ?? [];
    } catch {
      // `roles:manage` is a different permission from `invitations:manage`, so a
      // holder of only the latter gets a 403 here. Render nothing rather than an
      // error: they can still send the invitation, just without Roles.
      return [];
    }
  }, [orgId], { enabled: !!orgId });

  const selectable = useMemo(
    () => (roles.data ?? []).filter((r) => r.grantsRole !== 'superadmin'),
    [roles.data],
  );

  if (selectable.length === 0) return null;

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <fieldset className="mt-3" disabled={disabled} data-testid="invite-role-picker">
      <legend className="label">Roles <span className="font-normal text-fg-subtle">(optional)</span></legend>
      <p className="mb-2 text-xs text-fg-muted">
        Assigned when they accept, so they can work on day one. Fine-grained permissions come from{' '}
        <Link href="/dashboard/roles" className="action-link">Roles</Link> — pick one here instead of
        granting admin and demoting later.
      </p>
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-default p-2">
        {selectable.map((role) => (
          <label key={role.id} className="flex items-start gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-muted">
            <Checkbox
              checked={value.includes(role.id)}
              onChange={() => toggle(role.id)}
              aria-label={`Grant the ${role.name} role on acceptance`}
              className="mt-0.5 cursor-pointer"
            />
            <span className="min-w-0">
              <span className="block truncate text-fg">{role.name}</span>
              {role.description && (
                <span className="block truncate text-2xs text-fg-subtle">{role.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

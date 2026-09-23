// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { Users, Trash2, Pencil, X } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { LoadingSpinner } from '@/components/ui/Loading';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { ReadOnlyNotice } from '@/components/ui/ReadOnlyNotice';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useDelete } from '@/hooks/useDelete';
import { useFormState } from '@/hooks/useFormState';
import { formatError } from '@/lib/constants';
import type { IdpGroupMappingDto, IdpProtocol, IdpProvider, OrganizationRole } from '@/types';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * IdP group → Role mapping editor (3a), on the org SSO settings page.
 *
 * Each rule says "members the IdP puts in THIS group get THESE roles", applied
 * at every SSO sign-in: the membership is created if it doesn't exist, and the
 * mapped roles are reconciled. Roles an admin assigned by hand are shown on the
 * members page and are never removed by this — only roles a mapping granted are.
 *
 * Gated on `roles:manage` (a mapping IS a role grant) and on the `sso`
 * entitlement, both enforced server-side; the caller passes `readOnly` for an
 * impersonated session. Providers with no group claim (Google) get an
 * explanation instead of the editor — see `providerSupportsGroups` on the API.
 */
const NO_MAPPINGS: IdpGroupMappingDto[] = [];
const NO_ROLES: OrganizationRole[] = [];

export function SsoGroupMappings({
  orgId,
  provider,
  protocol = 'oidc',
  readOnly = false,
}: {
  orgId: string;
  /** The org's configured OIDC provider — `null` for none, and always null on a
   *  SAML config, which has no named provider. */
  provider: IdpProvider | null;
  /** Which protocol the org federates over. SAML carries groups in a mapped
   *  assertion ATTRIBUTE rather than a token claim, so the Google/GitHub
   *  carve-out below has nothing to say about it. */
  protocol?: IdpProtocol;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const form = useFormState();

  // Draft state — `editing` holds the id of the mapping being edited, or null
  // for the "add" form. One form serves both so the two can't drift.
  const [editing, setEditing] = useState<string | null>(null);
  const [group, setGroup] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);

  const configured = protocol === 'saml' || provider !== null;
  const supportsGroups = protocol === 'saml'
    || (provider !== null && provider !== 'google' && provider !== 'github');

  const { data: loaded, loading, error: loadError, refetch: load } = useFetch(async () => {
    if (!supportsGroups) return null;
    const [m, r] = await Promise.all([api.listIdpGroupMappings(orgId), api.getOrganizationRoles(orgId)]);
    return {
      mappings: m.success && m.data ? m.data.mappings : [],
      roles: r.success && r.data ? r.data.roles : [],
    };
  }, [orgId, supportsGroups]);
  const mappings = loaded?.mappings ?? NO_MAPPINGS;
  const roles = loaded?.roles ?? NO_ROLES;

  /** Roles a mapping may grant: everything except the platform-admin role, which
   *  the server refuses outright (a directory must not be able to mint one). */
  const assignableRoles = useMemo(
    () => roles.filter((r) => r.grantsRole !== 'superadmin'),
    [roles],
  );


  const resetDraft = () => { setEditing(null); setGroup(''); setRoleIds([]); };

  // `useFormState.run` owns the step-up replay: a write refused pending re-auth
  // finishes (reload + toast + draft reset) once the person confirms, instead of
  // leaving a red error under the confirmation dialog.
  const run = (fn: () => Promise<unknown>, successMsg: string) => form.run(fn, {
    onSuccess: () => {
      void load().then((reloaded) => { if (reloaded) toast.success(successMsg); });
      resetDraft();
    },
  });

  // Same for the delete — `useDelete` follows the replay through to the reload.
  const del = useDelete<IdpGroupMappingDto>(
    (m) => api.deleteIdpGroupMapping(orgId, m.id),
    () => {
      void load().then((reloaded) => { if (reloaded) toast.success('Group mapping removed'); });
      resetDraft();
    },
    (e) => form.setError(formatError(e)),
  );
  const busy = form.loading || del.loading;

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (readOnly || !group.trim() || roleIds.length === 0) return;
    const payload = { group: group.trim(), roleIds };
    void (editing
      ? run(() => api.updateIdpGroupMapping(orgId, editing, payload), 'Group mapping updated')
      : run(() => api.createIdpGroupMapping(orgId, payload), 'Group mapping created'));
  };

  const startEdit = (m: IdpGroupMappingDto) => {
    setEditing(m.id);
    setGroup(m.group);
    setRoleIds(m.roleIds);
  };

  const toggleRole = (id: string) => {
    setRoleIds((current) => (current.includes(id) ? current.filter((r) => r !== id) : [...current, id]));
  };

  return (
    <SectionCard
      icon={Users}
      title="Group to role mapping"
      description="Assign roles from your identity provider's groups. Members are added to this organization the first time they sign in."
    >
      {/* Google's limitation is stated here as well as on the connection form —
          this is the page someone lands on when they come looking for mapping. */}
      {!configured ? (
        <Callout variant="neutral">
          Configure an identity provider above before mapping its groups to roles.
        </Callout>
      ) : !supportsGroups ? (
        <Callout variant="warning" title="Group mapping is not available for this provider.">
          {provider === 'google'
            ? 'Google\'s OIDC tokens carry no group claim, so there are no groups to map. People signing in through Google are added to the organization as members; assign any further roles on the Roles page.'
            : 'GitHub is not an OpenID provider, so it supports neither SSO sign-in nor group-to-role mapping.'}
        </Callout>
      ) : (
        <>
          <ReadOnlyNotice show={readOnly} />
          {(form.error || loadError) && <div className="mb-3"><ErrorAlert message={form.error ?? formatError(loadError)} /></div>}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted py-4">
              <LoadingSpinner size="sm" /> Loading group mappings…
            </div>
          ) : (
            <>
              <div className="space-y-2 mb-4">
                {mappings.length === 0 && (
                  <EmptyState compact title="No group mappings yet" description="Add one below to map an IdP group onto roles." />
                )}
                {mappings.map((m) => (
                  <div key={m.id} className="flex items-start justify-between gap-3 rounded-lg border border-default p-3">
                    <div className="min-w-0">
                      <code className="text-sm font-medium break-all">{m.group}</code>
                      <div className="mt-1 text-xs text-fg-muted">
                        {m.roles.length > 0
                          ? <>Grants: {m.roles.map((r) => r.name).join(', ')}</>
                          : <em>Grants no existing role — the roles it named were deleted.</em>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        aria-label={`Edit ${m.group}`}
                        className="text-fg-muted hover:text-fg"
                        disabled={busy || readOnly}
                        onClick={() => startEdit(m)}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${m.group}`}
                        className="text-fg-muted hover:text-danger"
                        disabled={busy || readOnly}
                        onClick={() => del.open(m)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <form onSubmit={submit} className="rounded-lg border border-default p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold">{editing ? 'Edit mapping' : 'Add a mapping'}</h4>
                  {editing && (
                    <button type="button" aria-label="Cancel edit" className="text-fg-muted" onClick={resetDraft}>
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <fieldset disabled={readOnly} className="space-y-3">
                  <FormField
                    label="IdP group"
                    id="mapping-group"
                    hint="Exactly as your identity provider sends it. Matching ignores case."
                  >
                    <Input
                      id="mapping-group"
                      value={group}
                      onChange={(e) => setGroup(e.target.value)}
                      placeholder="platform-engineers"
                      className="font-mono text-sm"
                      disabled={busy}
                    />
                  </FormField>

                  <div>
                    <span className="label">Roles granted</span>
                    {assignableRoles.length === 0 ? (
                      <p className="text-xs text-fg-muted">
                        This organization has no roles to map yet.
                      </p>
                    ) : (
                      <div className="mt-1 space-y-1">
                        {assignableRoles.map((r) => (
                          <label key={r.id} className="flex items-center gap-2 text-sm">
                            <Checkbox
                              checked={roleIds.includes(r.id)}
                              onChange={() => toggleRole(r.id)}
                              disabled={busy}
                              aria-label={r.name}
                            />
                            {r.name}
                          </label>
                        ))}
                      </div>
                    )}
                    <p className="mt-1 text-xs text-fg-muted">
                      A mapping can never grant organization ownership or platform-administrator access, and
                      it never removes roles that were assigned by hand.
                    </p>
                  </div>

                  <Button type="submit" disabled={busy || !group.trim() || roleIds.length === 0}>
                    {editing ? 'Save mapping' : 'Add mapping'}
                  </Button>
                </fieldset>
              </form>
            </>
          )}
        </>
      )}

      {del.target && (
        <DeleteConfirmModal
          title="Delete group mapping"
          itemName={del.target.group}
          loading={del.loading}
          onCancel={del.close}
          onConfirm={() => void del.confirm()}
        />
      )}
    </SectionCard>
  );
}

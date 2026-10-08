// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import { useFormState } from '@/hooks/useFormState';
import api from '@/lib/api';

interface AddMemberModalProps {
  /** The org the member joins. */
  orgId: string;
  /** The active org parents teams, so offer the "also add to teams" picker. */
  offerTeams: boolean;
  /** Viewer holds `invitations:manage`, so the "they have no account yet" route
   *  is open to them and worth naming. Without it the link would lead to a page
   *  they cannot use. */
  canInvite: boolean;
  onClose: () => void;
  /** The member (and any teams) landed — refresh the roster. */
  onAdded: () => void;
}

const NO_TEAMS: { orgId: string; orgName: string }[] = [];

/**
 * Add an existing user to the org by email, optionally placing them on teams in
 * the same step.
 *
 * Owns the whole interaction — the email, the team roster it reads on open, the
 * selection, and the write. The page renders it only while it is open, so each
 * opening starts from a clean form instead of the page resetting five pieces of
 * state on its behalf.
 */
export function AddMemberModal({ orgId, offerTeams, canInvite, onClose, onAdded }: AddMemberModalProps) {
  const toast = useToast();
  const form = useFormState();
  const [email, setEmail] = useState('');
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());

  // Best-effort: no picker if the read fails, and the org add still works.
  const teamsQ = useFetch(
    async (signal) => (await api.getOrganizationTeams(orgId, { signal })).data?.teams ?? [],
    [orgId],
    { enabled: offerTeams },
  );
  const teamRoster = teamsQ.data ?? NO_TEAMS;

  const toggleTeam = (teamId: string) => setSelectedTeams((prev) => {
    const next = new Set(prev);
    if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
    return next;
  });

  const submit = async () => {
    const address = email.trim().toLowerCase();
    if (!address) return;
    await form.run(
      () => api.addMemberToOrganization(orgId, { email: address }),
      {
        onSuccess: () => {
          // The user now exists in the org; optionally place them on the selected
          // teams too (best-effort — a team failure doesn't undo the org add).
          if (selectedTeams.size > 0) {
            void api.bulkAddMemberToTeams(orgId, { email: address, orgIds: [...selectedTeams], role: 'member' })
              .then((res) => {
                if (res.success) toast.success(`Added to ${selectedTeams.size} team${selectedTeams.size === 1 ? '' : 's'}`);
                else toast.error(res.message || 'Member added, but adding to teams failed');
              })
              .catch(() => toast.error('Member added, but adding to teams failed'));
          }
          onAdded();
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      title="Add member"
      onClose={onClose}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={() => void submit()}
          confirmLabel="Add member"
          loading={form.loading}
          confirmDisabled={!email.trim()}
        />
      }
    >
      <p className="text-sm text-fg-muted mb-1">Enter the email address of an existing user to add to your organization.</p>
      {/* This modal only adds someone who ALREADY has an account — an
          unregistered address comes back as a bare 404 "User not found", which
          names no way forward. Inviting is a different page and a different
          permission, so the route out is stated up front rather than left to be
          discovered after the failure. */}
      <p className="text-xs text-fg-subtle mb-4">
        {canInvite ? (
          <>No account yet? <Link href="/dashboard/invitations" className="action-link underline">Send them an invitation</Link> instead.</>
        ) : 'If they have no account yet, an admin with invitation access needs to invite them first.'}
      </p>
      <Input
        type="email"
        placeholder="user@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        className="text-sm"
        autoFocus
      />
      {teamRoster.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-fg-muted mb-1.5">Also add to teams (optional)</p>
          <div className="space-y-0.5 max-h-40 overflow-y-auto border border-default rounded p-1">
            {teamRoster.map((t) => (
              <label key={t.orgId} className="flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-surface-muted cursor-pointer">
                <Checkbox
                  checked={selectedTeams.has(t.orgId)}
                  onChange={() => toggleTeam(t.orgId)}
                  disabled={form.loading}
                />
                <span className="truncate text-fg">{t.orgName}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <ErrorAlert message={form.error} className="mt-3" />
    </Modal>
  );
}

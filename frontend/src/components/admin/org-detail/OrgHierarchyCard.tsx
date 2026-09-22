// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import Link from 'next/link';
import { MoveRight, Network } from 'lucide-react';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { EligibleParentPicker, type ParentOrgOption } from '@/components/teams/EligibleParentPicker';
import { formatError } from '@/lib/constants';
import type { OrganizationDetail } from '@/lib/api/domains/organizations';

/**
 * Where the org sits in the org → team hierarchy (sysadmin drill-down): its
 * parent (linked) or "Top-level organization", its live teams (linked), and the
 * step-up gated "Move organization" action.
 */
export function OrgHierarchyCard({ org, onChanged }: { org: OrganizationDetail; onChanged: () => void }) {
  const [moving, setMoving] = useState(false);
  const teams = org.teams ?? [];
  const isTeam = !!org.parentOrgId;

  return (
    <Card>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Network className="w-5 h-5 text-fg-muted" />
          <h3 className="text-base font-semibold text-fg">Hierarchy</h3>
        </div>
        {org.id !== 'system' && (
          <button type="button" onClick={() => setMoving(true)} className="action-link text-sm">Move organization</button>
        )}
      </div>
      <dl className="text-sm space-y-2">
        <div>
          <dt className="text-fg-muted">Parent</dt>
          <dd>
            {isTeam ? (
              <Link href={`/dashboard/admin/orgs/${org.parentOrgId}`} className="action-link">
                {org.parentOrgName ?? org.parentOrgId}
              </Link>
            ) : 'Top-level organization'}
          </dd>
        </div>
        {!isTeam && (
          <div>
            <dt className="text-fg-muted">Teams ({teams.length})</dt>
            <dd>
              {teams.length === 0 ? (
                <span className="text-fg-subtle italic">None</span>
              ) : (
                <ul className="space-y-0.5">
                  {teams.map((t) => (
                    <li key={t.orgId}>
                      <Link href={`/dashboard/admin/orgs/${t.orgId}`} className="action-link">{t.orgName}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        )}
      </dl>

      {moving && (
        <MoveOrganizationDialog
          org={org}
          onClose={() => setMoving(false)}
          onMoved={() => { setMoving(false); onChanged(); }}
        />
      )}
    </Card>
  );
}

type Destination = 'parent' | 'top';

/**
 * Reparent an org (`POST /organization/:id/move`, sysadmin + step-up): nest it
 * under an eligible root, or — for a team — make it top-level. The rules are
 * stated up front; anything the backend still refuses (400) is shown verbatim.
 */
function MoveOrganizationDialog({ org, onClose, onMoved }: {
  org: OrganizationDetail;
  onClose: () => void;
  onMoved: () => void;
}) {
  const toast = useToast();
  const isTeam = !!org.parentOrgId;
  const hasTeams = (org.teams ?? []).length > 0;
  const [destination, setDestination] = useState<Destination>('parent');
  const [parent, setParent] = useState<ParentOrgOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // A root that still parents teams can't be nested (one level deep), and a root
  // can't be made "more" top-level — there is nothing to move it to.
  const blocked = !isTeam && hasTeams;
  const target: string | null = destination === 'top' ? null : parent?.id ?? '';
  const sameParent = destination === 'parent' && !!parent && parent.id === org.parentOrgId;
  const canSubmit = !blocked && !sameParent && (destination === 'top' ? isTeam : !!parent);

  const actionLabel = destination === 'top'
    ? `Make ${org.name} a top-level organization`
    : `Move ${org.name} under ${parent?.name ?? 'the selected organization'}`;

  const execute = async (stepUpToken: string) => {
    setConfirming(false);
    try {
      await api.moveOrganization(org.id, target, stepUpToken);
      invalidate.organizations();
      toast.success(destination === 'top' ? `${org.name} is now top-level` : `${org.name} moved under ${parent?.name}`);
      onMoved();
    } catch (e) {
      setError(formatError(e, 'Failed to move the organization'));
    }
  };

  return (
    <>
      <Modal
        title={`Move ${org.name}`}
        onClose={onClose}
        maxWidth="max-w-md"
        footer={(
          <ModalFooter
            onCancel={onClose}
            onConfirm={() => { setError(null); setConfirming(true); }}
            confirmLabel="Move"
            confirmDisabled={!canSubmit}
          />
        )}
      >
        <div className="space-y-4 text-sm">
          <ErrorAlert message={error} onDismiss={() => setError(null)} />
          <ul className="list-disc pl-5 space-y-1 text-fg-muted">
            <li>A team can move to another top-level organization on the Team or Enterprise plan, or become top-level itself.</li>
            <li>A top-level organization can be nested only if it has no teams of its own — teams are one level deep.</li>
            <li>A team takes its new parent&apos;s tier and shares its seats, quotas and billing.</li>
            <li>A top-level organization with an active subscription can&apos;t be nested — cancel the subscription first.</li>
            <li>A team made top-level starts on the default plan; set its tier or have it subscribe afterwards.</li>
          </ul>

          {blocked ? (
            <p className="text-warning">
              {org.name} has teams, so it can&apos;t be nested. Move or delete its teams first.
            </p>
          ) : (
            <fieldset className="space-y-3">
              <legend className="sr-only">Destination</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="move-destination" checked={destination === 'parent'} onChange={() => setDestination('parent')} />
                Nest under another organization
              </label>
              {destination === 'parent' && (
                <div className="pl-6">
                  <EligibleParentPicker value={parent} onChange={setParent} excludeOrgId={org.id} label="Destination organization" />
                  {sameParent && <p className="mt-1 text-xs text-warning">{org.name} is already a team of {parent?.name}.</p>}
                </div>
              )}
              {isTeam && (
                <label className="flex items-center gap-2">
                  <input type="radio" name="move-destination" checked={destination === 'top'} onChange={() => setDestination('top')} />
                  <span className="inline-flex items-center gap-1"><MoveRight className="w-3.5 h-3.5" /> Make top-level</span>
                </label>
              )}
            </fieldset>
          )}
        </div>
      </Modal>

      {confirming && (
        <StepUpModal
          title="Move this organization?"
          action={actionLabel}
          onConfirmed={execute}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

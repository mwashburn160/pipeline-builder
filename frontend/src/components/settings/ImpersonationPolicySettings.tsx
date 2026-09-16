// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Callout } from '@/components/ui/Callout';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import { ToggleRow } from '@/components/ui/SettingRow';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { EffectiveImpersonationPolicyDto, ImpersonationPolicy } from '@/lib/api/domains/organizations';

/** Plain-language options, from most to least permissive. */
const OPTIONS: { value: ImpersonationPolicy; label: string; description: string }[] = [
  {
    value: 'open',
    label: 'Open',
    description: 'Platform administrators can view a member\'s account without asking. Every view is still logged.',
  },
  {
    value: 'consent',
    label: 'Ask first',
    description: 'Someone must approve each request before an administrator can view an account.',
  },
  {
    value: 'denied',
    label: 'Emergencies only',
    description: 'No normal access. Emergency access needs a second platform administrator and notifies every admin here.',
  },
];

const LABEL: Record<ImpersonationPolicy, string> = { open: 'Open', consent: 'Ask first', denied: 'Emergencies only' };

/**
 * Whether platform administrators may view this organization's accounts.
 *
 * Shows both the organization's OWN setting and the one that actually APPLIES.
 * A parent organization can require something stricter (strictest wins), and
 * without saying so an admin who picks "Open" would never learn why it isn't.
 *
 * Saving requires re-entering the password: loosening this widens who can see
 * the organization's data.
 */
export function ImpersonationPolicySettings({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const toast = useToast();
  const [policy, setPolicy] = useState<EffectiveImpersonationPolicyDto | null>(null);
  const [draft, setDraft] = useState<{ impersonationPolicy: ImpersonationPolicy; allowSelfApproval: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingSave, setConfirmingSave] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getImpersonationPolicy(orgId);
      if (res.success && res.data) {
        setPolicy(res.data);
        // Edit the org's OWN setting — that is what saving changes.
        setDraft({ impersonationPolicy: res.data.own.policy, allowSelfApproval: res.data.own.allowSelfApproval });
      }
      setError(null);
    } catch (e) {
      setError(formatError(e, 'Could not load the access policy'));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const dirty = !!policy && !!draft && (
    draft.impersonationPolicy !== policy.own.policy || draft.allowSelfApproval !== policy.own.allowSelfApproval
  );

  const save = async (stepUpToken: string) => {
    if (!draft) return;
    try {
      const res = await api.updateImpersonationPolicy(orgId, draft, stepUpToken);
      if (res.success && res.data) {
        setPolicy(res.data);
        setDraft({ impersonationPolicy: res.data.own.policy, allowSelfApproval: res.data.own.allowSelfApproval });
        // The server says when a parent overrides the new setting; pass that on.
        toast.success(res.message || 'Access policy saved');
      }
      setError(null);
    } catch (e) {
      // e.g. "Emergencies only" on a deployment with a single platform administrator.
      setError(formatError(e, 'Could not save the access policy'));
    } finally {
      setConfirmingSave(false);
    }
  };

  return (
    <SectionCard
      icon={EyeOff}
      title="Administrator access"
      description="Whether platform administrators can view your members' accounts, for support and incidents. Every view is read-only and appears in the audit log."
    >
      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}

      {loading || !policy || !draft ? (
        <div className="flex items-center gap-2 py-4 text-sm text-[var(--pb-text-muted)]">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          {!policy.resolved && (
            <Callout variant="warning">
              The parent organization&apos;s setting couldn&apos;t be read, so the strictest policy applies until it can.
            </Callout>
          )}
          {policy.resolved && policy.inheritedFrom && (
            <Callout variant="neutral">
              Your parent organization requires a stricter policy, so <strong>{LABEL[policy.policy]}</strong> applies here
              {policy.policy !== policy.own.policy ? ` even though this organization is set to ${LABEL[policy.own.policy]}` : ''}.
            </Callout>
          )}

          <fieldset disabled={readOnly} className="space-y-2">
            <legend className="sr-only">Access policy</legend>
            {OPTIONS.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--pb-border)] p-3 has-[:checked]:border-[var(--pb-accent)]"
              >
                <input
                  type="radio"
                  name="impersonation-policy"
                  value={o.value}
                  className="mt-1"
                  checked={draft.impersonationPolicy === o.value}
                  onChange={() => setDraft({ ...draft, impersonationPolicy: o.value })}
                />
                <span>
                  <span className="block text-sm font-medium">{o.label}</span>
                  <span className="block text-xs text-[var(--pb-text-muted)]">{o.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <ToggleRow
            label="Let members approve access to their own account"
            description="When off, requests go to this organization's admins instead of the member."
            checked={draft.allowSelfApproval}
            disabled={readOnly || draft.impersonationPolicy === 'open'}
            onChange={(v) => setDraft({ ...draft, allowSelfApproval: v })}
          />

          <div className="flex justify-end">
            <Button type="button" disabled={readOnly || !dirty} onClick={() => setConfirmingSave(true)}>
              Save
            </Button>
          </div>
        </div>
      )}

      {confirmingSave && (
        <StepUpModal
          action="Change who can view this organization's accounts"
          onConfirmed={save}
          onClose={() => setConfirmingSave(false)}
        />
      )}
    </SectionCard>
  );
}

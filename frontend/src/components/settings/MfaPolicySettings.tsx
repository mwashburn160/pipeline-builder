// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { ToggleRow } from '@/components/ui/SettingRow';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgMfaPolicy } from '@/types';

/** What the admin is editing, before it is saved. */
interface Draft {
  requireMfa: boolean;
  graceDays: number;
  idpEnforcesMfa: boolean;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Whether this organization requires its members to sign in with two factors
 * (#8).
 *
 * The requirement is enforced when a token is ISSUED, not per route: once the
 * grace period ends, a member whose session was opened with a password alone
 * cannot sign in (or refresh) until they enrol a passkey or an authenticator
 * app. That is why the grace period is part of turning it on rather than an
 * afterthought — without it, saving this switch would sign out everyone who
 * hasn't enrolled yet, very often including the admin who just saved it.
 *
 * Saving is step-up gated, because turning the requirement OFF removes a control
 * for every member of the organization.
 */
export function MfaPolicySettings({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingSave, setConfirmingSave] = useState(false);

  const read = useFetch(
    async (signal): Promise<OrgMfaPolicy | null> => (await api.getMfaPolicy(orgId, { signal })).data ?? null,
    [orgId],
  );
  const policy = read.data;
  const loading = read.loading && !policy;

  // Edit the org's OWN setting — that is what saving changes; a parent's
  // requirement is shown but not editable from here. Re-seeded on every read.
  useEffect(() => {
    if (policy) setDraft({ requireMfa: policy.own, graceDays: policy.defaultGraceDays, idpEnforcesMfa: policy.idpEnforcesMfa });
  }, [policy]);

  const dirty = !!policy && !!draft
    && (draft.requireMfa !== policy.own || draft.idpEnforcesMfa !== policy.idpEnforcesMfa);
  const turningOn = !!policy && !!draft && draft.requireMfa && !policy.own;
  /** Members who would be locked out today — the grace period's whole purpose.
   *  Only meaningful where `policy.enrolment` is present, which is the only
   *  place it is read. */
  const outstanding = policy?.enrolment ? policy.enrolment.members - policy.enrolment.enrolled : 0;

  const save = async (stepUpToken: string) => {
    if (!draft) return;
    try {
      const res = await api.updateMfaPolicy(
        orgId,
        {
          requireMfa: draft.requireMfa,
          idpEnforcesMfa: draft.idpEnforcesMfa,
          // Only meaningful while turning it on; the server computes the
          // deadline from it so the client never posts a date.
          ...(turningOn ? { graceDays: draft.graceDays } : {}),
        },
        stepUpToken,
      );
      if (res.success && res.data) {
        toast.success(res.message || 'Two-factor policy saved');
        // Re-read rather than adopting the write's response: the READ is what
        // carries the enrolment counts, and enrolment moves on its own anyway.
        read.refetch();
      }
      setError(null);
    } catch (e) {
      // e.g. the bootstrap administrator has not enrolled a factor yet, which
      // this refuses rather than lock the install's only admin out.
      setError(formatError(e, 'Could not save the two-factor policy'));
    } finally {
      setConfirmingSave(false);
    }
  };

  return (
    <SectionCard
      icon={ShieldCheck}
      title="Two-factor authentication"
      description="Require every member to sign in with a passkey or an authenticator app, not a password alone."
    >
      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}

      {read.error && !policy ? (
        <RetryError message={formatError(read.error, 'Could not load the two-factor policy')} onRetry={read.refetch} />
      ) : loading || !policy || !draft ? (
        <div className="flex items-center gap-2 py-4 text-sm text-[var(--pb-text-muted)]">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          {policy.inheritedFrom && (
            <Callout variant="neutral">
              {policy.inheritedFromName
                ? <>The parent organization <strong>{policy.inheritedFromName}</strong> already requires</>
                : 'A parent organization already requires'}{' '}
              two-factor authentication, so it applies to this organization&apos;s members whatever is set here.
            </Callout>
          )}
          {policy.requireMfa && policy.graceUntil && !policy.enforced && (
            <Callout variant="warning">
              Members have until <strong>{formatDate(policy.graceUntil)}</strong> to enrol. Until then
              they are reminded but can still sign in with one factor; after it, they cannot sign in
              without a second one.
            </Callout>
          )}
          {policy.enforced && (
            <Callout variant="neutral">
              In force. Members who have not enrolled a passkey or an authenticator app cannot sign in.
            </Callout>
          )}

          {/* WHO IS READY. Choosing a grace period without this is guesswork:
              the same "14 days" is generous when everyone has enrolled and a
              mass lockout when nobody has. The tone follows the gap, and the
              count is of ACTIVE members (the people issuance will refuse). */}
          {policy.enrolment && (
            <Callout variant={outstanding === 0 ? 'success' : draft.requireMfa ? 'warning' : 'neutral'}>
              <strong>
                {policy.enrolment.enrolled} of {policy.enrolment.members}{' '}
                {policy.enrolment.members === 1 ? 'member has' : 'members have'} a passkey or an authenticator app.
              </strong>{' '}
              {outstanding === 0
                ? 'Everyone can already sign in with two factors, so the requirement can be applied immediately.'
                : `${outstanding} ${outstanding === 1 ? 'person' : 'people'} would be refused once the grace period ends.`}
            </Callout>
          )}

          <ToggleRow
            label="Require two-factor authentication"
            description="A passkey, or a password plus an authenticator code. Applies to everyone in this organization."
            checked={draft.requireMfa}
            disabled={readOnly}
            onChange={(v) => setDraft({ ...draft, requireMfa: v })}
          />

          {turningOn && (
            <FormField
              label="Grace period (days)"
              hint="How long members have to enrol before they are refused. 0 applies it immediately — only safe if everyone has already enrolled."
            >
              <Input
                type="number"
                min={0}
                max={90}
                value={String(draft.graceDays)}
                disabled={readOnly}
                onChange={(e) => setDraft({ ...draft, graceDays: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })}
                className="w-32"
              />
            </FormField>
          )}

          <ToggleRow
            label="Our identity provider enforces MFA"
            description="Turn this on only if your IdP genuinely requires a second factor. It makes single sign-on through it count as two-factor — identity providers rarely report this reliably, so this is your statement about your own provider."
            checked={draft.idpEnforcesMfa}
            disabled={readOnly}
            onChange={(v) => setDraft({ ...draft, idpEnforcesMfa: v })}
          />

          <div className="flex justify-end">
            <Button type="button" readOnly={readOnly} disabled={!dirty} onClick={() => setConfirmingSave(true)}>
              Save
            </Button>
          </div>
        </div>
      )}

      {confirmingSave && (
        <StepUpModal
          title={draft?.requireMfa ? 'Require two-factor authentication?' : 'Stop requiring two-factor authentication?'}
          action={draft?.requireMfa
            ? 'Require two-factor authentication for this organization'
            : 'Stop requiring two-factor authentication for this organization'}
          details={draft?.requireMfa ? (
            <p>
              {turningOn && draft.graceDays > 0
                ? `Members have ${draft.graceDays} ${draft.graceDays === 1 ? 'day' : 'days'} to enrol; after that they cannot sign in without a second factor.`
                : 'Members who have not enrolled a passkey or an authenticator app cannot sign in.'}
              {policy?.enrolment && outstanding > 0
                ? ` That is ${outstanding} of ${policy.enrolment.members} today.`
                : ''}
            </p>
          ) : (
            <p>This removes a control for every member of the organization — single-factor sessions are issued again.</p>
          )}
          onConfirmed={save}
          onClose={() => setConfirmingSave(false)}
        />
      )}
    </SectionCard>
  );
}

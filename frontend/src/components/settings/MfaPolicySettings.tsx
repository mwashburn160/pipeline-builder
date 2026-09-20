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
import { MfaRequiredError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import { formatDateLong } from '@/lib/format';
import type { OrgMfaPolicy } from '@/types';

/** What the admin is editing, before it is saved. */
interface Draft {
  requireMfa: boolean;
  graceDays: number;
  idpEnforcesMfa: boolean;
  adminActionsRequireMfa: boolean;
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
 * A second, separate policy — "administrative actions require MFA" — leaves
 * sign-in alone but demands a session opened with a second factor for role,
 * member, invitation, IdP group-mapping, billing, log-export and access-key
 * actions. It travels to every service inside the session token, so changing it
 * ends every other member's session (they sign in again and pick it up).
 *
 * Saving is step-up gated. WEAKENING anything — turning either requirement off,
 * or stating that the IdP enforces MFA — also needs a session opened with a
 * second factor; the server answers a single-factor session with 401
 * `MFA_REQUIRED`, which the shell turns into the enrol / sign-in-again dialog.
 * Tightening never does, so an admin without MFA can still adopt it.
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
    if (policy) {
      setDraft({
        requireMfa: policy.own,
        graceDays: policy.defaultGraceDays,
        idpEnforcesMfa: policy.idpEnforcesMfa,
        adminActionsRequireMfa: policy.adminActionsOwn,
      });
    }
  }, [policy]);

  const requireChanged = !!policy && !!draft && draft.requireMfa !== policy.own;
  const idpChanged = !!policy && !!draft && draft.idpEnforcesMfa !== policy.idpEnforcesMfa;
  const adminChanged = !!policy && !!draft && draft.adminActionsRequireMfa !== policy.adminActionsOwn;
  const dirty = requireChanged || idpChanged || adminChanged;
  const turningOn = !!policy && !!draft && draft.requireMfa && !policy.own;
  /** The save WEAKENS something, so the server will want a two-factor session. */
  const loosening = !!policy && !!draft && (
    (requireChanged && !draft.requireMfa)
    || (adminChanged && !draft.adminActionsRequireMfa)
    || (idpChanged && draft.idpEnforcesMfa)
  );
  /** Members who would be locked out today — the grace period's whole purpose.
   *  Only meaningful where `policy.enrolment` is present, which is the only
   *  place it is read. */
  const outstanding = policy?.enrolment ? policy.enrolment.members - policy.enrolment.enrolled : 0;
  /** Of those, the ones who were asked to protect their own account and said
   *  "don't ask again". A reminder will not move them, so a deadline is the
   *  only thing that will — which is precisely what this panel is deciding. */
  const declined = policy?.enrolment?.declined ?? 0;

  const save = async (stepUpToken: string) => {
    if (!draft) return;
    try {
      const res = await api.updateMfaPolicy(
        orgId,
        {
          requireMfa: draft.requireMfa,
          idpEnforcesMfa: draft.idpEnforcesMfa,
          ...(adminChanged ? { adminActionsRequireMfa: draft.adminActionsRequireMfa } : {}),
          // Only meaningful while turning it on; the server computes the
          // deadline from it so the client never posts a date.
          ...(turningOn ? { graceDays: draft.graceDays } : {}),
        },
        stepUpToken,
      );
      if (res.success && res.data) {
        const refreshed = res.data.sessionsRefreshed ?? 0;
        toast.success(refreshed > 0
          ? `${res.message || 'Two-factor policy saved'} — ${refreshed} ${refreshed === 1 ? 'member was' : 'members were'} signed out to pick up the change.`
          : res.message || 'Two-factor policy saved');
        // Re-read rather than adopting the write's response: the READ is what
        // carries the enrolment counts, and enrolment moves on its own anyway.
        read.refetch();
      }
      setError(null);
    } catch (e) {
      // A weakening save from a single-factor session: the shell already shows
      // the "two-factor authentication required" dialog with the way to enrol,
      // so a second, generic error here would only repeat it less helpfully.
      if (e instanceof MfaRequiredError) {
        setError(null);
        return;
      }
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
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted">
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
              Members have until <strong>{formatDateLong(policy.graceUntil)}</strong> to enrol. Until then
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
              {/* Counts, never names. Who declined is in the audit log
                  (`user.mfa.prompt_declined`), on the surface that already
                  gates reading it. */}
              {declined > 0 && (
                <>
                  {' '}
                  {declined === 1
                    ? 'One of them has been asked and chose not to be reminded again'
                    : `${declined} of them have been asked and chose not to be reminded again`}
                  {' '}— a reminder will not reach them, so a deadline is what would.
                </>
              )}
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

          <div className="border-t border-default pt-4 space-y-3">
            {policy.adminActionsInheritedFrom && !policy.adminActionsOwn && (
              <Callout variant="neutral">
                {policy.adminActionsInheritedFromName
                  ? <>The parent organization <strong>{policy.adminActionsInheritedFromName}</strong> already requires</>
                  : 'A parent organization already requires'}{' '}
                two-factor authentication for administrative actions, so it applies here whatever is set below.
              </Callout>
            )}
            <ToggleRow
              label="Require two-factor authentication for administrative actions"
              description={'Managing roles, members, invitations, IdP group mappings, billing, exporting logs and creating access keys will need a session '
                + 'opened with a passkey or an authenticator code — even while signing in with a password alone is still allowed. '
                + 'API keys and service accounts are not affected, except that only a person can create a new access key. '
                + 'Changing this signs every other member of this organization and its teams out, so the change applies to them at once.'}
              checked={draft.adminActionsRequireMfa}
              disabled={readOnly}
              onChange={(v) => setDraft({ ...draft, adminActionsRequireMfa: v })}
            />
          </div>

          {loosening && (
            <Callout variant="warning">
              This change weakens your organization&apos;s protection, so it needs a session you opened with a passkey
              or an authenticator code — a password sign-in is not enough, even with the confirmation that follows.
            </Callout>
          )}

          <div className="flex justify-end">
            <Button type="button" readOnly={readOnly} disabled={!dirty} onClick={() => setConfirmingSave(true)}>
              Save
            </Button>
          </div>
        </div>
      )}

      {confirmingSave && (
        <StepUpModal
          title={loosening ? 'Weaken the two-factor policy?' : 'Save the two-factor policy?'}
          action={loosening ? 'Weaken this organization\'s two-factor policy' : 'Save this organization\'s two-factor policy'}
          details={(
            <div className="space-y-2">
              {requireChanged && (draft?.requireMfa ? (
                <p>
                  {turningOn && draft.graceDays > 0
                    ? `Members have ${draft.graceDays} ${draft.graceDays === 1 ? 'day' : 'days'} to enrol; after that they cannot sign in without a second factor.`
                    : 'Members who have not enrolled a passkey or an authenticator app cannot sign in.'}
                  {policy?.enrolment && outstanding > 0
                    ? ` That is ${outstanding} of ${policy.enrolment.members} today.`
                    : ''}
                </p>
              ) : (
                <p>Signing in stops requiring a second factor — single-factor sessions are issued again for every member.</p>
              ))}
              {adminChanged && (draft?.adminActionsRequireMfa ? (
                <p>Administrative actions will need a session opened with a second factor. Every other member is signed out so this applies at once.</p>
              ) : (
                <p>Administrative actions will no longer need a second factor. Every other member is signed out so this applies at once.</p>
              ))}
              {idpChanged && (draft?.idpEnforcesMfa ? (
                <p>Single sign-on through your identity provider will count as two-factor authentication on your word.</p>
              ) : (
                <p>Single sign-on will no longer count as two-factor authentication.</p>
              ))}
            </div>
          )}
          onConfirmed={save}
          onClose={() => setConfirmingSave(false)}
        />
      )}
    </SectionCard>
  );
}

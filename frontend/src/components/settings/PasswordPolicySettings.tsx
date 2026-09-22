// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { KeySquare } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgPasswordPolicy } from '@/types';

/**
 * The org's minimum password length (at or above the platform minimum, at most
 * the platform maximum; a parent org's stricter minimum also applies here).
 *
 * WHAT IT CAN AND CAN'T DO — stated in the UI because it is the question an
 * admin asks: only password HASHES are stored, so existing passwords can't be
 * checked when the minimum is raised. It applies to every password set from now
 * on, and to each member's NEXT password sign-in, where a shorter password must
 * be changed before a session opens. Passkey, social and SSO sign-ins never see
 * a password, so they are unaffected.
 *
 * Saving is step-up gated; LOWERING the minimum also needs a session opened with
 * a second factor (the server says so if it isn't).
 */
export function PasswordPolicySettings({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const toast = useToast();
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [confirmingSave, setConfirmingSave] = useState(false);

  const read = useFetch(
    async (signal): Promise<OrgPasswordPolicy | null> => (await api.getPasswordPolicy(orgId, { signal })).data ?? null,
    [orgId],
  );
  const policy = read.data;

  useEffect(() => {
    if (policy) setDraft(policy.own === null ? '' : String(policy.own));
  }, [policy]);

  /** The value to send: a number, or null to clear the org's own minimum. */
  const next: number | null = draft.trim() === '' ? null : Number(draft);
  const invalid = next !== null && (!Number.isInteger(next) || !policy || next < policy.platformMinLength || next > policy.maxLength);
  const dirty = !!policy && next !== policy.own;
  const loosening = !!policy && policy.own !== null && (next === null || next < policy.own);

  const save = async (stepUpToken: string) => {
    try {
      const res = await api.updatePasswordPolicy(orgId, { minLength: next }, stepUpToken);
      if (res.success) {
        toast.success(res.message || 'Password policy saved');
        void read.refetch();
      }
      setError(null);
    } catch (e) {
      setError(formatError(e, 'Could not save the password policy'));
    } finally {
      setConfirmingSave(false);
    }
  };

  return (
    <SectionCard
      icon={KeySquare}
      title="Password policy"
      description="The minimum password length for this organization's members."
    >
      {error && <div className="mb-3"><ErrorAlert message={error} /></div>}

      {read.error && !policy ? (
        <RetryError message={formatError(read.error, 'Could not load the password policy')} onRetry={read.refetch} />
      ) : !policy ? (
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          {policy.inheritedFrom && (
            <Callout variant="neutral">
              {policy.inheritedFromName
                ? <>The parent organization <strong>{policy.inheritedFromName}</strong> requires</>
                : 'A parent organization requires'}{' '}
              at least <strong>{policy.minLength}</strong> characters, so that applies here whatever is set below.
            </Callout>
          )}

          <FormField
            label="Minimum length (characters)"
            hint={`Between ${policy.platformMinLength} (the platform minimum) and ${policy.maxLength}. Leave empty to use the platform minimum. In force now: ${policy.minLength}.`}
          >
            <Input
              type="number"
              min={policy.platformMinLength}
              max={policy.maxLength}
              value={draft}
              placeholder={String(policy.platformMinLength)}
              disabled={readOnly}
              onChange={(e) => setDraft(e.target.value)}
              className="w-32"
              aria-invalid={invalid}
            />
          </FormField>
          {invalid && (
            <p className="text-xs text-danger">
              Enter a whole number from {policy.platformMinLength} to {policy.maxLength}.
            </p>
          )}

          <Callout variant="info">
            Existing passwords can&apos;t be checked — only their hashes are stored. A raised minimum applies to every
            password set from now on, and at each member&apos;s next password sign-in: a shorter password must be
            changed before they can continue. Every new password is also checked against known data breaches.
          </Callout>

          {loosening && (
            <Callout variant="warning">
              Lowering the minimum weakens your organization&apos;s protection, so it needs a session you opened with a
              passkey or an authenticator code.
            </Callout>
          )}

          <div className="flex justify-end">
            <Button type="button" readOnly={readOnly} disabled={!dirty || invalid} onClick={() => setConfirmingSave(true)}>
              Save
            </Button>
          </div>
        </div>
      )}

      {confirmingSave && (
        <StepUpModal
          title={loosening ? 'Lower the password minimum?' : 'Save the password policy?'}
          action={next === null ? 'Use the platform minimum password length' : `Require passwords of at least ${next} characters`}
          details={(
            <p>
              {next === null
                ? 'Members\' passwords will only need to meet the platform minimum (and any parent organization\'s).'
                : `Members whose password is shorter than ${next} characters will be asked to change it at their next password sign-in.`}
            </p>
          )}
          onConfirmed={save}
          onClose={() => setConfirmingSave(false)}
        />
      )}
    </SectionCard>
  );
}

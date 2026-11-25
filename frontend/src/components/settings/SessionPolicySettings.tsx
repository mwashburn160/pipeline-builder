// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgSessionPolicy } from '@/types';

/** The most an org may store for either bound (platform `SESSION_POLICY_MAX_DAYS`). */
export const SESSION_POLICY_MAX_DAYS = 365;

type Field = 'maxAgeDays' | 'idleTimeoutDays';

/** A draft field: empty = clear the org's own bound; otherwise whole days 1–365. */
export function parseSessionDays(raw: string): { value: number | null; invalid: boolean } {
  const t = raw.trim();
  if (t === '') return { value: null, invalid: false };
  const n = Number(t);
  return { value: n, invalid: !Number.isInteger(n) || n < 1 || n > SESSION_POLICY_MAX_DAYS };
}

/** Raising a bound, or clearing one that was set, lengthens sessions. */
function lengthens(from: number | null, to: number | null): boolean {
  return from !== null && (to === null || to > from);
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * The org's interactive-session lifetime: a MAXIMUM AGE (from the sign-in that
 * opened the session — however active it has been) and an IDLE TIMEOUT (since
 * its last use). Both may only TIGHTEN the platform ceiling, and the strictest
 * value across this org and its parents applies.
 *
 * Stated in the UI because it is what an admin needs to know: a tightened bound
 * takes effect at each session's next refresh (within minutes), and machine
 * credentials (access keys, service accounts) keep their own fixed end.
 *
 * Saving is step-up gated; LENGTHENING sessions (raising or clearing a bound)
 * also needs a session opened with a second factor (the server says so if not).
 */
export function SessionPolicySettings({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const [draft, setDraft] = useState<Record<Field, string>>({ maxAgeDays: '', idleTimeoutDays: '' });
  const [confirmingSave, setConfirmingSave] = useState(false);

  const read = useFetch(
    async (signal): Promise<OrgSessionPolicy | null> => {
      const data = (await api.getSessionPolicy(orgId, { signal })).data;
      // An envelope with no policy is a failed read — shown with a retry — not
      // a half-rendered form.
      if (!data) throw new Error('The session policy could not be read');
      return data;
    },
    [orgId],
  );
  const policy = read.data;

  useEffect(() => {
    if (policy) {
      setDraft({
        maxAgeDays: policy.own.maxAgeDays === null ? '' : String(policy.own.maxAgeDays),
        idleTimeoutDays: policy.own.idleTimeoutDays === null ? '' : String(policy.own.idleTimeoutDays),
      });
    }
  }, [policy]);

  const maxAge = parseSessionDays(draft.maxAgeDays);
  const idle = parseSessionDays(draft.idleTimeoutDays);
  const invalid = maxAge.invalid || idle.invalid;

  /** Only the fields that changed — the PATCH treats an absent field as unchanged. */
  const body: { maxAgeDays?: number | null; idleTimeoutDays?: number | null } = {};
  if (policy && maxAge.value !== policy.own.maxAgeDays) body.maxAgeDays = maxAge.value;
  if (policy && idle.value !== policy.own.idleTimeoutDays) body.idleTimeoutDays = idle.value;
  const dirty = Object.keys(body).length > 0;
  const loosening = !!policy && (
    ('maxAgeDays' in body && lengthens(policy.own.maxAgeDays, maxAge.value))
    || ('idleTimeoutDays' in body && lengthens(policy.own.idleTimeoutDays, idle.value))
  );

  const save = useMutation({
    fn: async (patch: typeof body, stepUpToken: string) => {
      const res = await api.updateSessionPolicy(orgId, patch, stepUpToken);
      if (!res.success) throw new Error(res.message || 'Could not save the session policy');
      return res;
    },
    scopeKey: orgId,
    errorFallback: 'Could not save the session policy',
    toast: { success: (res) => res.message || 'Session policy saved' },
    onSuccess: () => { void read.refetch(); },
    onStepUpResumed: () => { void read.refetch(); },
  });

  const confirm = async (stepUpToken: string) => {
    try {
      await save.run(body, stepUpToken);
    } finally {
      setConfirmingSave(false);
    }
  };

  const edit = (field: Field, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    save.reset();
  };

  const summary = () => {
    const parts: string[] = [];
    if ('maxAgeDays' in body) parts.push(body.maxAgeDays == null ? 'clear the maximum session age' : `end sessions ${days(body.maxAgeDays)} after sign-in`);
    if ('idleTimeoutDays' in body) parts.push(body.idleTimeoutDays == null ? 'clear the idle timeout' : `sign out sessions idle for ${days(body.idleTimeoutDays)}`);
    const text = parts.join(' and ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  };

  const field = (
    key: Field,
    label: string,
    effective: number,
    platformValue: number,
    parsed: { invalid: boolean },
    inheritedFromName: string | undefined,
    inherited: boolean,
  ) => (
    <div>
      <FormField
        label={label}
        hint={`Platform default: ${days(platformValue)}. In force now: ${days(effective)}${inherited ? ` (set by ${inheritedFromName ?? 'a parent organization'})` : ''}. Leave empty to use the platform default.`}
      >
        <Input
          type="number"
          min={1}
          max={SESSION_POLICY_MAX_DAYS}
          value={draft[key]}
          placeholder={String(platformValue)}
          disabled={readOnly}
          onChange={(e) => edit(key, e.target.value)}
          className="w-32"
          aria-invalid={parsed.invalid}
        />
      </FormField>
      {parsed.invalid && (
        <p className="mt-1 text-xs text-danger">Enter a whole number of days from 1 to {SESSION_POLICY_MAX_DAYS}.</p>
      )}
    </div>
  );

  return (
    <SectionCard
      icon={Timer}
      title="Session policy"
      description="How long a member's sign-in lasts."
    >
      {save.error && <div className="mb-3"><ErrorAlert message={save.error} /></div>}

      {read.error && !policy ? (
        <RetryError message={formatError(read.error, 'Could not load the session policy')} onRetry={read.refetch} />
      ) : !policy ? (
        <div className="flex items-center gap-2 py-4 text-sm text-fg-muted">
          <LoadingSpinner size="sm" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          {(policy.maxAgeInheritedFrom || policy.idleTimeoutInheritedFrom) && (
            <Callout variant="neutral">
              A parent organization sets a stricter limit, so it applies here whatever is set below.
            </Callout>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {field('maxAgeDays', 'Maximum session age (days)', policy.maxAgeDays, policy.platform.maxAgeDays, maxAge,
              policy.maxAgeInheritedFromName, !!policy.maxAgeInheritedFrom)}
            {field('idleTimeoutDays', 'Idle timeout (days)', policy.idleTimeoutDays, policy.platform.idleTimeoutDays, idle,
              policy.idleTimeoutInheritedFromName, !!policy.idleTimeoutInheritedFrom)}
          </div>

          <Callout variant="info">
            These can only shorten the platform defaults — a longer value has no effect. A shorter limit applies to
            signed-in browsers and CLI sessions at their next refresh, within minutes; members past it are asked to
            sign in again. Access keys and service accounts keep their own expiry.
          </Callout>

          {loosening && (
            <Callout variant="warning">
              Lengthening sessions weakens your organization&apos;s protection, so it needs a session you opened with a
              passkey or an authenticator code.
            </Callout>
          )}

          <div className="flex justify-end">
            <Button
              type="button"
              readOnly={readOnly}
              disabled={!dirty || invalid}
              loading={save.pending}
              onClick={() => setConfirmingSave(true)}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {confirmingSave && dirty && (
        <StepUpModal
          title={loosening ? 'Lengthen sessions?' : 'Save the session policy?'}
          action={summary()}
          details={(
            <p>
              {loosening
                ? 'Members will stay signed in for longer (never beyond the platform default or a parent organization\'s limit).'
                : 'Members whose session is older, or idler, than the new limit will be asked to sign in again.'}
            </p>
          )}
          onConfirmed={confirm}
          onClose={() => setConfirmingSave(false)}
        />
      )}
    </SectionCard>
  );
}

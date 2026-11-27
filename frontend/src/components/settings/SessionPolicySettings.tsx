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
import { Select } from '@/components/ui/Select';
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

/** The shortest idle timeout anything may set (platform `SESSION_IDLE_TIMEOUT_MIN_MINUTES`). */
export const SESSION_IDLE_TIMEOUT_MIN_MINUTES = 5;

/**
 * Idle-timeout presets (minutes): 5, 10 and 15 minutes fit the default
 * 15-minute ceiling; the longer ones appear only when an operator raised the
 * ceiling (`SESSION_IDLE_TIMEOUT_MINUTES`) far enough — an org can only shorten it.
 */
export const IDLE_TIMEOUT_PRESETS = [5, 10, 15, 30, 60, 480, 1440] as const;

/** The idle select's value for "type my own". */
const CUSTOM = 'custom';

/** A draft maximum age: empty = clear the org's own bound; otherwise whole days 1–365. */
export function parseSessionDays(raw: string): { value: number | null; invalid: boolean } {
  const t = raw.trim();
  if (t === '') return { value: null, invalid: false };
  const n = Number(t);
  return { value: n, invalid: !Number.isInteger(n) || n < 1 || n > SESSION_POLICY_MAX_DAYS };
}

/** A draft custom idle timeout: empty = clear; otherwise whole minutes from 5 up to `ceiling`. */
export function parseIdleMinutes(raw: string, ceiling: number): { value: number | null; invalid: boolean } {
  const t = raw.trim();
  if (t === '') return { value: null, invalid: false };
  const n = Number(t);
  return { value: n, invalid: !Number.isInteger(n) || n < SESSION_IDLE_TIMEOUT_MIN_MINUTES || n > ceiling };
}

/** "5 minutes", "1 hour", "8 hours", "1 day". */
export function formatMinutes(n: number): string {
  if (n % 1440 === 0) return `${n / 1440} day${n === 1440 ? '' : 's'}`;
  if (n % 60 === 0) return `${n / 60} hour${n === 60 ? '' : 's'}`;
  return `${n} minute${n === 1 ? '' : 's'}`;
}

/** The idle draft: a preset (its minutes as a string), '' (platform default) or custom + its text. */
interface IdleDraft { choice: string; custom: string }

function idleDraftOf(own: number | null, ceiling: number): IdleDraft {
  if (own === null) return { choice: '', custom: '' };
  const preset = IDLE_TIMEOUT_PRESETS.some((p) => p === own && p <= ceiling);
  return preset ? { choice: String(own), custom: '' } : { choice: CUSTOM, custom: String(own) };
}

/** Raising a bound, or clearing one that was set, lengthens sessions. */
function lengthens(from: number | null, to: number | null): boolean {
  return from !== null && (to === null || to > from);
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * The org's interactive-session lifetime: a MAXIMUM AGE in days (from the
 * sign-in that opened the session — however active it has been) and an IDLE
 * TIMEOUT in minutes (since its last real activity — a polling tab nobody
 * touches is idle). Both may only TIGHTEN the platform ceiling, and the
 * strictest value across this org and its parents applies. The idle timeout
 * offers presets up to the platform ceiling, the platform default, and a
 * custom value (5 minutes up to the ceiling).
 *
 * Stated in the UI because it is what an admin needs to know: a tightened bound
 * takes effect at each session's next refresh (within minutes), and machine
 * credentials (access keys, service accounts) keep their own fixed end.
 *
 * Saving is step-up gated; LENGTHENING sessions (raising or clearing a bound)
 * also needs a session opened with a second factor (the server says so if not).
 */
export function SessionPolicySettings({ orgId, readOnly }: { orgId: string; readOnly: boolean }) {
  const [maxAgeDraft, setMaxAgeDraft] = useState('');
  const [idleDraft, setIdleDraft] = useState<IdleDraft>({ choice: '', custom: '' });
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
      setMaxAgeDraft(policy.own.maxAgeDays === null ? '' : String(policy.own.maxAgeDays));
      setIdleDraft(idleDraftOf(policy.own.idleTimeoutMinutes, policy.platform.idleTimeoutMinutes));
    }
  }, [policy]);

  const idleCeiling = policy?.platform.idleTimeoutMinutes ?? SESSION_IDLE_TIMEOUT_MIN_MINUTES;
  const maxAge = parseSessionDays(maxAgeDraft);
  // An empty custom box is not "clear": it is unfinished.
  const idle = idleDraft.choice === CUSTOM
    ? (idleDraft.custom.trim() === '' ? { value: null, invalid: true } : parseIdleMinutes(idleDraft.custom, idleCeiling))
    : { value: idleDraft.choice === '' ? null : Number(idleDraft.choice), invalid: false };
  const invalid = maxAge.invalid || idle.invalid;

  /** Only the fields that changed — the PATCH treats an absent field as unchanged. */
  const body: { maxAgeDays?: number | null; idleTimeoutMinutes?: number | null } = {};
  if (policy && maxAge.value !== policy.own.maxAgeDays) body.maxAgeDays = maxAge.value;
  if (policy && !idle.invalid && idle.value !== policy.own.idleTimeoutMinutes) body.idleTimeoutMinutes = idle.value;
  const dirty = Object.keys(body).length > 0;
  const loosening = !!policy && (
    ('maxAgeDays' in body && lengthens(policy.own.maxAgeDays, maxAge.value))
    || ('idleTimeoutMinutes' in body && lengthens(policy.own.idleTimeoutMinutes, idle.value))
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

  const editMaxAge = (value: string) => {
    setMaxAgeDraft(value);
    save.reset();
  };
  const editIdle = (next: Partial<IdleDraft>) => {
    setIdleDraft((d) => ({ ...d, ...next }));
    save.reset();
  };

  const summary = () => {
    const parts: string[] = [];
    if ('maxAgeDays' in body) parts.push(body.maxAgeDays == null ? 'clear the maximum session age' : `end sessions ${days(body.maxAgeDays)} after sign-in`);
    if ('idleTimeoutMinutes' in body) parts.push(body.idleTimeoutMinutes == null ? 'clear the idle timeout' : `sign out sessions idle for ${formatMinutes(body.idleTimeoutMinutes)}`);
    const text = parts.join(' and ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  };

  const inForce = (effective: string, inheritedFromName: string | undefined, inherited: boolean) =>
    `In force now: ${effective}${inherited ? ` (set by ${inheritedFromName ?? 'a parent organization'})` : ''}.`;

  const maxAgeField = (p: OrgSessionPolicy) => (
    <div>
      <FormField
        label="Maximum session age (days)"
        hint={`Platform default: ${days(p.platform.maxAgeDays)}. ${inForce(days(p.maxAgeDays), p.maxAgeInheritedFromName, !!p.maxAgeInheritedFrom)} Leave empty to use the platform default.`}
      >
        <Input
          type="number"
          min={1}
          max={SESSION_POLICY_MAX_DAYS}
          value={maxAgeDraft}
          placeholder={String(p.platform.maxAgeDays)}
          disabled={readOnly}
          onChange={(e) => editMaxAge(e.target.value)}
          className="w-32"
          aria-invalid={maxAge.invalid}
        />
      </FormField>
      {maxAge.invalid && (
        <p className="mt-1 text-xs text-danger">Enter a whole number of days from 1 to {SESSION_POLICY_MAX_DAYS}.</p>
      )}
    </div>
  );

  const idleField = (p: OrgSessionPolicy) => {
    const ceiling = p.platform.idleTimeoutMinutes;
    const presets = IDLE_TIMEOUT_PRESETS.filter((m) => m <= ceiling);
    return (
      <div className="space-y-2">
        <FormField
          label="Idle timeout"
          hint={`Platform default: ${formatMinutes(ceiling)}. ${inForce(formatMinutes(p.idleTimeoutMinutes), p.idleTimeoutInheritedFromName, !!p.idleTimeoutInheritedFrom)} Members with no activity for this long are signed out; a tab that only refreshes in the background counts as idle.`}
        >
          <Select
            value={idleDraft.choice}
            disabled={readOnly}
            onChange={(e) => editIdle({ choice: e.target.value })}
            className="w-56"
          >
            <option value="">Platform default ({formatMinutes(ceiling)})</option>
            {presets.map((m) => <option key={m} value={String(m)}>{formatMinutes(m)}</option>)}
            <option value={CUSTOM}>Custom…</option>
          </Select>
        </FormField>
        {idleDraft.choice === CUSTOM && (
          <div>
            <FormField label="Custom idle timeout (minutes)">
              <Input
                type="number"
                min={SESSION_IDLE_TIMEOUT_MIN_MINUTES}
                max={ceiling}
                step={1}
                value={idleDraft.custom}
                disabled={readOnly}
                onChange={(e) => editIdle({ custom: e.target.value })}
                className="w-32"
                aria-invalid={idle.invalid}
              />
            </FormField>
            {idle.invalid && (
              <p className="mt-1 text-xs text-danger">
                Enter a whole number of minutes from {SESSION_IDLE_TIMEOUT_MIN_MINUTES} to {ceiling}.
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

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
            {maxAgeField(policy)}
            {idleField(policy)}
          </div>

          <Callout variant="info">
            These can only shorten the platform defaults. A shorter limit applies to signed-in browsers and CLI
            sessions at their next refresh, within minutes; members past it are asked to sign in again. Browsers warn
            2 minutes before an idle sign-out. Access keys and service accounts keep their own expiry.
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

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { KeyRound, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { RecoveryCodes } from '@/components/settings/RecoveryCodes';
import { TotpQrCode } from '@/components/settings/TotpQrCode';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { CopyButton } from '@/components/ui/CopyButton';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useLoadable } from '@/hooks/useLoadable';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { TotpEnrolment, TotpStatus } from '@/types';

/** Nothing enrolled — the shape a failed status read must NOT be mistaken for. */
const OFF: TotpStatus = {
  enabled: false, pending: false, activatedAt: null, lastUsedAt: null,
  recoveryCodesRemaining: 0, recoveryCodesTotal: 0, recoveryGeneratedAt: null, lockedUntil: null,
};

/**
 * Authenticator-app (TOTP) management — where a person turns two-factor
 * authentication on, off, and re-keys their recovery codes.
 *
 * It sits in Settings → Security next to "Passkeys", and for the same reason:
 * both are credentials for the PERSON, unlike the machine-facing access keys.
 *
 * Three server-gated actions, each opening ONE `StepUpModal` — which states what
 * the action costs and takes the factor in the same dialog, rather than a
 * confirm-then-step-up pair asking the same question twice:
 *   - ENROL, which mints a secret and shows it once (QR + typed key), then takes
 *     a code back to prove the app really has it;
 *   - DISABLE, which destroys the factor;
 *   - REGENERATE, which invalidates every recovery code already written down.
 * "Activate" is deliberately NOT gated a second time — it confirms the secret the
 * gated call just issued, and the code in the field is the proof.
 *
 * `readOnly` (read-only impersonation) disables every write, matching the
 * backend's refusal — an operator viewing an account must not be able to leave,
 * or take away, a factor in it.
 */
export function TotpSection({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();

  const loadStatus = useCallback(async (): Promise<TotpStatus> => {
    const res = await api.getTotpStatus();
    // A load failure must NOT render as "two-factor is off" — on a security
    // surface a false-negative reads as "nothing is protecting this account".
    if (!res.success || !res.data) throw new Error('Failed to load two-factor status');
    return res.data.totp;
  }, []);
  const { data: status, loading, error: loadError, reload } = useLoadable<TotpStatus>(loadStatus, OFF, 'Failed to load two-factor status');

  // The in-flight enrolment (secret + QR), held only until it is confirmed or
  // abandoned. Never written anywhere but component state.
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [code, setCode] = useState('');
  const [activating, setActivating] = useState(false);

  // Which step-up the modal is currently being opened for (null = closed). The
  // dialog states the consequence itself — see the module note on the one-dialog
  // rule — so there is no separate confirm step in front of it.
  const [pendingStepUp, setPendingStepUp] = useState<'enrol' | 'disable' | 'regenerate' | null>(null);
  const [busy, setBusy] = useState(false);

  // A freshly minted set, shown once. Separate from `enrolment` because
  // regeneration produces one without any enrolment in flight.
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  const startEnrol = async (stepUpToken: string) => {
    setBusy(true);
    try {
      const res = await api.enrolTotp(stepUpToken);
      if (!res.success || !res.data) { toast.error(res.message || 'Could not start setup'); return; }
      setCode('');
      setEnrolment(res.data);
    } catch (err) {
      toast.error(formatError(err, 'Could not start setup'));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) { toast.error('Enter the 6-digit code from your authenticator app'); return; }
    setActivating(true);
    try {
      const res = await api.activateTotp(trimmed);
      if (!res.success || !res.data) { toast.error(res.message || 'That code isn\'t right'); return; }
      setEnrolment(null);
      setCode('');
      // Recovery codes come only with the account's FIRST second factor; an
      // account that already has a set (from a passkey) keeps it.
      if (res.data.recoveryCodes.length > 0) setFreshCodes(res.data.recoveryCodes);
      toast.success('Two-factor authentication is on');
      void reload();
    } catch (err) {
      // The server distinguishes a wrong code from a lockout; show its wording.
      toast.error(formatError(err, 'That code isn\'t right'));
    } finally {
      setActivating(false);
    }
  };

  const disable = async (stepUpToken: string) => {
    setBusy(true);
    try {
      const res = await api.disableTotp(stepUpToken);
      if (!res.success) { toast.error(res.message || 'Could not turn two-factor off'); return; }
      toast.success('Two-factor authentication is off');
      void reload();
    } catch (err) {
      // Includes the server's "this is the only way you can sign in" refusal.
      toast.error(formatError(err, 'Could not turn two-factor off'));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (stepUpToken: string) => {
    setBusy(true);
    try {
      const res = await api.regenerateRecoveryCodes(stepUpToken);
      if (!res.success || !res.data) { toast.error(res.message || 'Could not create new recovery codes'); return; }
      setFreshCodes(res.data.recoveryCodes);
      void reload();
    } catch (err) {
      toast.error(formatError(err, 'Could not create new recovery codes'));
    } finally {
      setBusy(false);
    }
  };

  /** Route the step-up token to whichever action asked for it. */
  const onStepUpConfirmed = async (token: string) => {
    const action = pendingStepUp;
    setPendingStepUp(null);
    if (action === 'enrol') await startEnrol(token);
    else if (action === 'disable') await disable(token);
    else if (action === 'regenerate') await regenerate(token);
  };

  /** Heading, summary and consequence for whichever action is being gated. */
  const stepUpCopy = pendingStepUp === 'enrol'
    ? {
      title: 'Set up an authenticator app?',
      action: 'Set up an authenticator app',
      details: <p>A setup key and QR code are issued next; two-factor only turns on once you enter a code from the app.</p>,
    }
    : pendingStepUp === 'disable'
      ? {
        title: 'Turn off two-factor authentication?',
        action: 'Turn off two-factor authentication',
        details: (
          <p>
            Signing in will need only your password again — and, unless you also have a
            passkey, your recovery codes stop working. Remove the entry from your
            authenticator app too.
          </p>
        ),
      }
      : {
        title: 'Replace your recovery codes?',
        action: 'Replace your recovery codes',
        details: (
          <p>
            Every code you have written down stops working immediately, including
            any you haven&apos;t used — they are one set for your whole account, shared with
            your passkeys. You&apos;ll get a new set to save.
          </p>
        ),
      };

  const lockedOut = !!status.lockedUntil && new Date(status.lockedUntil).getTime() > Date.now();

  return (
    <SectionCard
      icon={Smartphone}
      title="Authenticator app"
      description="A 6-digit code from an app on your phone, asked for after your password. It protects the account even if the password leaks — and unlike a passkey it works on any device you sign in from."
      actions={status.enabled ? <Badge color="green">On</Badge> : undefined}
    >
      {loading && !status.enabled && !status.pending ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : loadError ? (
        <RetryError message={loadError} onRetry={() => void reload()} />
      ) : freshCodes ? (
        <RecoveryCodes
          codes={freshCodes}
          onDone={() => setFreshCodes(null)}
          title={status.enabled ? 'Your new recovery codes' : 'Save your recovery codes'}
        />
      ) : enrolment ? (
        // -- Enrolment in flight: scan, then prove it worked -----------------
        <form onSubmit={activate} className="space-y-4">
          <div className="flex flex-wrap items-start gap-5">
            <TotpQrCode value={enrolment.otpauthUri} />
            <div className="flex-1 min-w-[220px] space-y-3">
              <p className="text-sm text-fg-muted">
                Scan this with Google Authenticator, 1Password, Aegis or whichever app you use.
              </p>
              <div>
                <p className="text-xs text-fg-muted mb-1">Can&apos;t scan? Enter this setup key by hand:</p>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-sm break-all rounded bg-surface-muted px-2 py-1">{enrolment.secret}</code>
                  <CopyButton text={enrolment.secret} />
                </div>
              </div>
            </div>
          </div>

          <FormField label="Code from the app" hint="Six digits. It changes every 30 seconds.">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="123456"
              maxLength={10}
              className="max-w-[160px]"
              disabled={activating}
              autoFocus
            />
          </FormField>

          <div className="flex gap-2">
            <Button type="submit" loading={activating} disabled={!code.trim()}>Turn on</Button>
            <Button
              type="button"
              variant="secondary"
              disabled={activating}
              onClick={() => { setEnrolment(null); setCode(''); }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : status.enabled ? (
        // -- Enrolled ---------------------------------------------------------
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-fg-muted">Turned on</dt>
              <dd>{status.activatedAt ? <RelativeTime value={status.activatedAt} /> : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Last used</dt>
              <dd>{status.lastUsedAt ? <RelativeTime value={status.lastUsedAt} /> : <span className="text-fg-subtle">never</span>}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Recovery codes left</dt>
              <dd>{status.recoveryCodesRemaining} of {status.recoveryCodesTotal}</dd>
            </div>
          </dl>

          {status.recoveryCodesRemaining === 0 && (
            <Callout variant="danger" title="No recovery codes left">
              If you lose the device running your authenticator app you will not be
              able to get back in without an administrator. Create a new set now.
            </Callout>
          )}
          {status.recoveryCodesRemaining > 0 && status.recoveryCodesRemaining <= 2 && (
            <Callout variant="warning" title="Running low on recovery codes">
              Only {status.recoveryCodesRemaining} left. Creating a new set replaces all of them.
            </Callout>
          )}
          {lockedOut && (
            <Callout variant="warning" title="Temporarily locked">
              Too many incorrect codes were entered. Codes are refused until{' '}
              <RelativeTime value={status.lockedUntil!} />.
            </Callout>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              readOnly={readOnly}
              loading={busy}
              onClick={() => setPendingStepUp('regenerate')}
              className="gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" /> New recovery codes
            </Button>
            <Button
              variant="danger-outline"
              readOnly={readOnly}
              disabled={busy}
              onClick={() => setPendingStepUp('disable')}
              className="gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" /> Turn off
            </Button>
          </div>
        </div>
      ) : (
        // -- Not enrolled -----------------------------------------------------
        <div className="space-y-3">
          {status.pending && (
            <Callout variant="neutral" title="Setup was never finished">
              An earlier setup wasn&apos;t confirmed, so it isn&apos;t protecting
              anything. Starting again issues a new key.
            </Callout>
          )}
          <Button
            readOnly={readOnly}
            loading={busy || pendingStepUp === 'enrol'}
            onClick={() => setPendingStepUp('enrol')}
            className="gap-1"
          >
            <KeyRound className="w-4 h-4" /> Set up authenticator app
          </Button>
        </div>
      )}

      {pendingStepUp && (
        <StepUpModal
          title={stepUpCopy.title}
          action={stepUpCopy.action}
          details={stepUpCopy.details}
          onConfirmed={onStepUpConfirmed}
          onClose={() => setPendingStepUp(null)}
        />
      )}
    </SectionCard>
  );
}

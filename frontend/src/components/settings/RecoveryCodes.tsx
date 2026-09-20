// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { SecretActions } from '@/components/ui/SecretActions';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useLoadable } from '@/hooks/useLoadable';
import { useQuery } from '@/hooks/useQuery';
import api from '@/lib/api';
import { invalidate, queries } from '@/lib/api-cache';
import { formatError } from '@/lib/constants';
import type { RecoveryCodeStatus } from '@/types';

/**
 * The one and only showing of a set of recovery codes.
 *
 * They are stored hashed, so this is genuinely the last time they exist in
 * readable form — which is why the panel is loud, offers both copy and download,
 * and makes the person acknowledge before it goes away rather than closing on
 * the next render. That action row is {@link SecretActions}, shared with every
 * other one-time secret the app reveals.
 *
 * The codes back up the ACCOUNT, not one factor: there is one set, minted with
 * whichever second factor came first (a passkey or an authenticator app), and
 * any code signs in when that factor is lost.
 */
export function RecoveryCodes({
  codes,
  onDone,
  title = 'Save your recovery codes',
}: {
  codes: string[];
  onDone: () => void;
  title?: string;
}) {
  const asText = codes.join('\n');

  return (
    <div className="space-y-3">
      <Callout variant="warning" icon={ShieldCheck} title={title}>
        Each code works once, and this is the only time they are shown. Store them
        somewhere you can reach <strong>without</strong> your passkey device or your
        authenticator app — they are how you get back in if you lose them.
      </Callout>

      <ul
        className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-default bg-surface-muted p-4 font-mono text-sm"
        aria-label="Recovery codes"
      >
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>

      <SecretActions
        text={asText}
        filename="pipeline-builder-recovery-codes.txt"
        fileHeader={'Pipeline Builder recovery codes\n\nEach code works once. Keep them somewhere you can reach without your passkey or authenticator device.'}
        onDone={onDone}
        doneLabel="I've saved them"
      />
    </div>
  );
}

const EMPTY: RecoveryCodeStatus = { remaining: 0, total: 0, generatedAt: null };

/**
 * How many recovery codes the account has left, and a way to replace the set —
 * for an account whose second factor is a PASSKEY. An account that also has an
 * authenticator app sees the same set in that panel instead, so this renders
 * nothing there rather than offer two buttons for one sheet.
 *
 * Replacing is step-up gated server-side (every code already written down stops
 * working), so it opens a `StepUpModal` first.
 */
export function AccountRecoveryCodes({ readOnly }: { readOnly: boolean }) {
  const toast = useToast();
  const { refreshUser } = useAuth();
  const load = useCallback(async (): Promise<RecoveryCodeStatus> => {
    const codes = await api.getRecoveryCodeStatus();
    if (!codes.success || !codes.data) throw new Error('Failed to load recovery codes');
    return codes.data.recoveryCodes;
  }, []);
  const { data: status, reload } = useLoadable<RecoveryCodeStatus>(load, EMPTY, 'Failed to load recovery codes');
  // Shared with the TOTP panel and the posture strip through the read cache
  // rather than a third request for the same answer.
  const { data: totp } = useQuery(queries.totpStatus());
  const totpEnabled = totp?.enabled === true;
  const [confirming, setConfirming] = useState(false);
  const [fresh, setFresh] = useState<string[] | null>(null);

  const regenerate = async (stepUpToken: string) => {
    setConfirming(false);
    try {
      const res = await api.regenerateRecoveryCodes(stepUpToken);
      if (!res.success || !res.data) { toast.error(res.message || 'Could not create new recovery codes'); return; }
      setFresh(res.data.recoveryCodes);
      void reload();
      // The remaining-code count lives on the TOTP status too, and the posture
      // strip reads it off the profile.
      invalidate.totpStatus();
      void refreshUser({ force: true });
    } catch (err) {
      toast.error(formatError(err, 'Could not create new recovery codes'));
    }
  };

  if (fresh) {
    return <RecoveryCodes codes={fresh} onDone={() => setFresh(null)} title="Your new recovery codes" />;
  }
  if (totpEnabled) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          <span className="text-fg-muted">Recovery codes left: </span>
          <strong>{status.remaining} of {status.total}</strong>
        </span>
        <Button
          variant="secondary"
          size="xs"
          readOnly={readOnly}
          onClick={() => setConfirming(true)}
          className="gap-1"
        >
          <RefreshCw className="w-3.5 h-3.5" /> New recovery codes
        </Button>
      </div>
      {status.total > 0 && status.remaining === 0 && (
        <Callout variant="danger" title="No recovery codes left">
          If you lose your passkeys now, an admin of your organization will have to reset your
          two-factor authentication. Create a new set.
        </Callout>
      )}
      {status.remaining > 0 && status.remaining <= 2 && (
        <Callout variant="warning" title="Running low on recovery codes">
          Only {status.remaining} left. Creating a new set replaces all of them.
        </Callout>
      )}
      {confirming && (
        <StepUpModal
          title="Replace your recovery codes?"
          action="Replace your recovery codes"
          details={(
            <p>
              Every code you have written down stops working immediately, including any you
              haven&apos;t used. You&apos;ll get a new set to save.
            </p>
          )}
          onConfirmed={regenerate}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

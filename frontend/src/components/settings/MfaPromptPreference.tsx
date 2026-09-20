// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { BellOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { formatDateLong } from '@/lib/format';
import type { MfaNudgeState } from '@/types';

/**
 * The way back from "don't ask again".
 *
 * A durable choice the person can't undo is a trap, so the decline they made on
 * the password-only banner (`components/ui/MfaEnrolmentNudge.tsx`) is shown
 * here, in words, next to the factors it is about — with one button that
 * restores the prompt. The snooze appears the same way: "reminders are off and
 * here is until when" is a fact worth being able to see rather than infer from
 * silence.
 *
 * Renders NOTHING in the ordinary case. `user.mfaNudge` is sent only while a
 * suppression is actually in force AND the account still holds no factor, so an
 * account that enrolled — which clears the state server-side — has nothing to
 * reverse and sees no card.
 */
interface MfaPromptPreferenceProps {
  /** The suppression in force, from `user.mfaNudge`. Absent ⇒ nothing to undo,
   *  and the card renders nothing. Passed in rather than read from `useAuth`
   *  here so this stays a plain component of the page that owns the profile. */
  nudge?: MfaNudgeState;
  readOnly: boolean;
  /** Re-read the profile once the server has forgotten the suppression. */
  onChanged: () => void | Promise<void>;
}

export function MfaPromptPreference({ nudge, readOnly, onChanged }: MfaPromptPreferenceProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!nudge) return null;

  const restore = async () => {
    setBusy(true);
    try {
      await api.restoreMfaPrompt();
      await onChanged();
      toast.success('Reminders are back on.');
    } catch (e) {
      toast.error(formatError(e, 'Could not turn the reminders back on'));
    } finally {
      setBusy(false);
    }
  };

  const declined = !!nudge.declinedAt;

  return (
    <SectionCard
      icon={BellOff}
      title="Reminders to add a second factor"
      description="Whether this account is protected is decided by the factors above, not by a setting. This only controls whether we remind you."
    >
      <div className="space-y-3">
        <Callout variant="neutral">
          {declined ? (
            <>
              You asked on {formatDateLong(nudge.declinedAt!)} not to be reminded again, so the
              banner stays hidden. Your account is still protected by a password alone — adding a
              passkey above is what changes that.
            </>
          ) : (
            <>
              Reminders are paused until <strong>{formatDateLong(nudge.snoozedUntil!)}</strong>.
              Adding a passkey or an authenticator app above ends them for good.
            </>
          )}
        </Callout>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" readOnly={readOnly} disabled={busy} onClick={() => void restore()}>
            {busy ? 'Saving…' : 'Remind me again'}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

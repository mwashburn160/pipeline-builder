// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ArrowLeft, HelpCircle, KeyRound, LogIn, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { LostFactorHelp } from './LostFactorHelp';
import type { SignInFlow } from './useSignInFlow';

/**
 * Second factor. Replaces the whole card body rather than appearing below it:
 * the password is already proven and re-showing the field only invites people
 * to retype it.
 */
export function MfaStep({ flow }: { flow: SignInFlow }) {
  const { handleMfaSubmit, mfaCode, setMfaCode, mfaBusy, cancelMfa, lostFactorOpen, setLostFactorOpen } = flow;
  return (
    <form onSubmit={handleMfaSubmit} className="space-y-3">
      <p className="text-sm text-fg-muted flex items-start gap-2">
        <Smartphone className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>Enter the 6-digit code from your authenticator app.</span>
      </p>
      {/* The recovery code is named HERE, in the sentence, not left to a
          placeholder that vanishes the moment anyone types: this is the exact
          point where someone discovers their phone is gone. */}
      <p className="text-sm text-fg-muted flex items-start gap-2">
        <KeyRound className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Phone lost or wiped — or you sign in with a passkey you no longer have? Use one of
          the recovery codes you saved when you set up two-factor authentication — they go in
          this same box, and each one works once.
        </span>
      </p>
      <Input
        id="signin-mfa-code"
        type="text"
        // `one-time-code` is what lets iOS/Android offer the code from the
        // SMS/authenticator sheet instead of making people switch apps.
        autoComplete="one-time-code"
        inputMode="text"
        required
        autoFocus
        placeholder="123456 or a recovery code"
        aria-label="Authentication code"
        value={mfaCode}
        onChange={(e) => setMfaCode(e.target.value)}
        disabled={mfaBusy}
      />
      <Button type="submit" fullWidth disabled={mfaBusy || !mfaCode.trim()} className="text-sm">
        {mfaBusy
          ? <><LoadingSpinner size="sm" className="mr-2" /> Verifying...</>
          : <><LogIn className="w-4 h-4 mr-1.5" /> Verify</>
        }
      </Button>
      <Button type="button" variant="secondary" fullWidth onClick={cancelMfa} disabled={mfaBusy} className="text-sm">
        <ArrowLeft className="w-4 h-4 mr-1.5" /> Use a different account
      </Button>
      {/* Folded away by default — most people have a code — and honest when
          opened: recovery is an operator action, not a self-service button. */}
      <button
        type="button"
        onClick={() => setLostFactorOpen((v) => !v)}
        aria-expanded={lostFactorOpen}
        className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-fg-muted hover:text-fg focus:outline-none focus:ring-2 focus:ring-brand rounded py-1"
      >
        <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
        Lost your phone and your codes?
      </button>
      {lostFactorOpen && <LostFactorHelp />}
    </form>
  );
}

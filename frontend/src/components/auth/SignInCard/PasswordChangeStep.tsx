// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ArrowLeft, KeyRound, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import type { SignInFlow } from './useSignInFlow';

/** The password was right but is below the org's policy: choose a new one. */
export function PasswordChangeStep({ flow, minLength }: { flow: SignInFlow; minLength: number }) {
  const { handlePasswordChangeSubmit, newPassword, setNewPassword, confirmNewPassword, setConfirmNewPassword, pwChangeBusy, cancelPasswordChange } = flow;
  return (
    <form onSubmit={handlePasswordChangeSubmit} className="space-y-3">
      <p className="text-sm text-fg-muted flex items-start gap-2">
        <KeyRound className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Your organization now requires passwords of at least <strong>{minLength}</strong> characters,
          and yours is shorter. Choose a new one to continue — it also signs you out everywhere else.
        </span>
      </p>
      <Input
        id="signin-new-password"
        type="password"
        autoComplete="new-password"
        required
        autoFocus
        minLength={minLength}
        placeholder={`New password (${minLength}+ characters)`}
        aria-label="New password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        disabled={pwChangeBusy}
      />
      <Input
        id="signin-new-password-confirm"
        type="password"
        autoComplete="new-password"
        required
        placeholder="Confirm new password"
        aria-label="Confirm new password"
        value={confirmNewPassword}
        onChange={(e) => setConfirmNewPassword(e.target.value)}
        disabled={pwChangeBusy}
      />
      <Button type="submit" fullWidth disabled={pwChangeBusy || !newPassword || !confirmNewPassword} className="text-sm">
        {pwChangeBusy
          ? <><LoadingSpinner size="sm" className="mr-2" /> Saving...</>
          : <><LogIn className="w-4 h-4 mr-1.5" /> Change password and sign in</>
        }
      </Button>
      <Button type="button" variant="secondary" fullWidth onClick={cancelPasswordChange} disabled={pwChangeBusy} className="text-sm">
        <ArrowLeft className="w-4 h-4 mr-1.5" /> Use a different account
      </Button>
    </form>
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Building2, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/Loading';
import type { SignInFlow } from './useSignInFlow';

/**
 * An SSO-backed identifier: NO password field. The backend refuses a password
 * (and a social grant) for these accounts anyway, so offering one only produces
 * a rejection the person can't act on. Submitting the surrounding form starts
 * the SSO hand-off.
 */
export function SsoPanel({ flow }: { flow: SignInFlow }) {
  const { ssoAccount, ssoDomain, ssoBusy, ssoProviderName, setBreakGlass } = flow;
  return (
    <>
      <p className="text-sm text-fg-muted flex items-start gap-2" role="status">
        <Building2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          {ssoAccount
            ? 'This account signs in through your organization’s identity provider, so a password here won’t work.'
            : `${ssoDomain} is managed by your organization — sign-in happens at its identity provider.`}
        </span>
      </p>
      <Button type="submit" fullWidth disabled={ssoBusy} className="text-sm">
        {ssoBusy
          ? <><LoadingSpinner size="sm" className="mr-2" /> Redirecting…</>
          : <><LogIn className="w-4 h-4 mr-1.5" /> Continue with {ssoProviderName}</>}
      </Button>
      {/* Owners are exempt from their org's "SSO required" policy, but discovery
          can't say who is an owner, so the password path is offered on request
          and the server decides. */}
      {!ssoAccount && (
        <button
          type="button"
          onClick={() => setBreakGlass(true)}
          className="w-full text-xs text-fg-muted hover:text-fg underline py-1"
        >
          Organization owner? Sign in with your password or passkey
        </button>
      )}
    </>
  );
}

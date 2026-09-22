// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Building2, Eye, EyeOff, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/Loading';
import { SsoPanel } from './SsoPanel';
import type { SignInFlow } from './useSignInFlow';

/** The first leg: identifier, then a password — or the SSO hand-off when the identifier is federated. */
export function PasswordStep({ flow }: { flow: SignInFlow }) {
  const {
    ssoRequired, ssoOffered, ssoBusy, startSso, handleSignIn, identifier, changeIdentifier, discoverSso,
    isSubmitting, showPassword, setShowPassword, password, setPassword,
  } = flow;
  return (
    <form onSubmit={ssoRequired ? startSso : handleSignIn} className="space-y-3">
      <Input
        id="signin-identifier"
        type="text"
        // `webauthn` is what puts discoverable passkeys into this field's
        // autofill dropdown; it is inert without a conditional-UI ceremony
        // waiting, so it is safe to always declare.
        autoComplete="username webauthn"
        required
        placeholder="Email or username"
        aria-label="Email or username"
        value={identifier}
        onChange={(e) => changeIdentifier(e.target.value)}
        // Anyone who tabs straight past gets the answer now rather than after
        // the debounce.
        onBlur={() => { void discoverSso(identifier); }}
        disabled={isSubmitting || ssoBusy}
      />
      {ssoRequired ? (
        <SsoPanel flow={flow} />
      ) : (
        <>
          <div className="relative">
            <Input
              id="signin-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              className="pr-10"
              placeholder="Password"
              aria-label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              disabled={isSubmitting}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-fg-muted hover:text-fg focus:outline-none focus:ring-2 focus:ring-brand"
            >
              {showPassword ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
          <Button type="submit" fullWidth disabled={isSubmitting} className="text-sm">
            {isSubmitting
              ? <><LoadingSpinner size="sm" className="mr-2" /> Signing in...</>
              : <><LogIn className="w-4 h-4 mr-1.5" /> Sign in</>
            }
          </Button>
          {ssoOffered && (
            <Button type="button" variant="secondary" fullWidth disabled={ssoBusy} className="text-sm" onClick={(e) => { void startSso(e); }}>
              {ssoBusy
                ? <><LoadingSpinner size="sm" className="mr-2" /> Redirecting…</>
                : <><Building2 className="w-4 h-4 mr-1.5" /> Continue with single sign-on</>}
            </Button>
          )}
        </>
      )}
    </form>
  );
}

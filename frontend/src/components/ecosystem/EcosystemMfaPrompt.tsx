// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';
import { PASSKEY_ENROLMENT_HREF, SECURITY_HREF } from '@/lib/security-links';
import type { User } from '@/types';

/**
 * Shown in place of the Ecosystem console when the session is not MFA-grade
 * (`aal < 2`). Every ecosystem-management route requires `requireAssurance`
 * (aal2), so rendering the console would only produce a wall of 401s.
 *
 * An account that already holds a factor just needs to sign in again with it
 * (enrolling doesn't raise the CURRENT session's level); one with none must
 * enrol first.
 */
export function EcosystemMfaPrompt({ user }: { user: Pick<User, 'authFactors'> }) {
  const f = user.authFactors;
  const hasFactor = !!f && (f.passkeyCount > 0 || f.hasTotp);
  return (
    <Callout variant="warning" icon={ShieldAlert} title="Two-factor sign-in required">
      <p>
        The Ecosystem console needs a session opened with a second factor (a passkey or an authenticator app).
        {hasFactor
          ? ' This session was opened with one factor — sign out and sign in again using your passkey or authenticator app.'
          : ' Your account has no second factor yet — add one, then sign in again with it.'}
      </p>
      <p className="mt-2">
        <Link href={hasFactor ? SECURITY_HREF : PASSKEY_ENROLMENT_HREF} className="font-medium underline underline-offset-2">
          {hasFactor ? 'Open security settings' : 'Set up two-factor authentication'}
        </Link>
      </p>
    </Callout>
  );
}

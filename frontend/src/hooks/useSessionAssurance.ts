// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { decodeJwt } from '@/lib/jwt';
import type { User } from '@/types';

export type AssuranceLevel = 1 | 2;

/**
 * The current session's assurance level (`aal`), or `null` until mounted.
 *
 * The authoritative value is the access token's own `aal` claim — the same
 * claim `requireAssurance` checks server-side. The profile only echoes it
 * (`user.mfaPolicy.aal`) for orgs that require MFA, so that is the fallback;
 * with neither, the session is treated as single-factor (fail closed: the worst
 * case is an enrol prompt, never a console full of 401s).
 *
 * Browser state (the token), so it's read after mount only; `user` is a
 * dependency because a sign-in / org switch / refresh re-issues the token and
 * the profile along with it.
 */
export function readSessionAssurance(user: Pick<User, 'mfaPolicy'> | null | undefined): AssuranceLevel {
  let claim: unknown;
  try {
    const token = api.getAccessToken();
    claim = token ? decodeJwt(token)?.payload?.aal : undefined;
  } catch {
    claim = undefined;
  }
  if (claim === 1 || claim === 2) return claim;
  return user?.mfaPolicy?.aal === 2 ? 2 : 1;
}

export function useSessionAssurance(user: Pick<User, 'mfaPolicy'> | null | undefined): AssuranceLevel | null {
  const [aal, setAal] = useState<AssuranceLevel | null>(null);
  useEffect(() => {
    setAal(readSessionAssurance(user));
  }, [user]);
  return aal;
}

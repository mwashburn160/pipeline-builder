// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleDashed, type LucideIcon } from 'lucide-react';
import { useFetch } from '@/hooks/useFetch';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import api from '@/lib/api';
import { hasPermission } from '@/lib/auth-helpers';
import { formatDate } from '@/lib/format';
import {
  PASSKEY_ENROLMENT_HREF, SECURITY_HREF, SESSIONS_HREF, TOTP_ENROLMENT_HREF,
} from '@/lib/security-links';
import type { User } from '@/types';

/** Where the org-level controls live. */
export const ORG_MFA_SETTINGS_HREF = '/dashboard/settings?tab=organization';
export const ORG_SSO_SETTINGS_HREF = '/dashboard/settings/sso';
const FACTORS_HREF = `${SECURITY_HREF}?tab=factors`;
const PASSWORD_HREF = `${FACTORS_HREF}#password`;
const DEVICES_HREF = `${SESSIONS_HREF}#devices`;

/** Recovery codes at or below this count are flagged. */
export const LOW_RECOVERY_CODES = 2;

type Tone = 'good' | 'warn' | 'neutral';

export interface PostureItem {
  id: string;
  label: string;
  value: string;
  tone: Tone;
  href: string;
  /** A short line of context, shown under the value. */
  detail?: string;
}

const TONE_ICON: Record<Tone, LucideIcon> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  neutral: CircleDashed,
};

const TONE_CLASS: Record<Tone, string> = {
  good: 'text-success',
  warn: 'text-amber-600 dark:text-amber-400',
  neutral: 'text-fg-muted',
};

interface PostureInputs {
  user: User;
  /** `null` = not loaded / not applicable. */
  recoveryCodes: { remaining: number; total: number } | null;
  /** Browser sessions signed in as this account; `null` while unknown. */
  activeSessions: number | null;
  /** The org's IdP config, when the viewer may read it: `undefined` = not
   *  readable (no permission / not entitled), `null` = none configured. */
  sso: { enabled: boolean } | null | undefined;
  /** The viewer can change the org's MFA requirement. */
  canManageOrg: boolean;
}

/**
 * The posture items, derived ONLY from what the APIs report — nothing inferred.
 * Exported for tests.
 */
export function derivePosture({ user, recoveryCodes, activeSessions, sso, canManageOrg }: PostureInputs): PostureItem[] {
  const f = user.authFactors;
  const items: PostureItem[] = [];
  const hasSecondFactor = !!f && (f.hasTotp || f.passkeyCount > 0);

  if (f) {
    items.push({
      id: 'password',
      label: 'Password',
      value: f.hasPassword ? 'Set' : 'Not set',
      // No password is a normal state for OAuth / SSO accounts — not a warning.
      tone: f.hasPassword ? 'good' : 'neutral',
      href: PASSWORD_HREF,
    });
    items.push({
      id: 'passkeys',
      label: 'Passkeys',
      value: f.passkeyCount === 0 ? 'None' : String(f.passkeyCount),
      tone: f.passkeyCount > 0 ? 'good' : 'neutral',
      href: PASSKEY_ENROLMENT_HREF,
    });
    items.push({
      id: 'totp',
      label: 'Authenticator app',
      value: f.hasTotp ? 'On' : 'Off',
      tone: f.hasTotp ? 'good' : 'neutral',
      href: TOTP_ENROLMENT_HREF,
    });
  }

  if (f?.hasTotp && recoveryCodes) {
    const low = recoveryCodes.remaining <= LOW_RECOVERY_CODES;
    items.push({
      id: 'recovery',
      label: 'Recovery codes',
      value: `${recoveryCodes.remaining} of ${recoveryCodes.total} left`,
      tone: low ? 'warn' : 'good',
      href: TOTP_ENROLMENT_HREF,
      detail: low ? 'Running low — create a new set' : undefined,
    });
  }

  if (activeSessions !== null) {
    items.push({
      id: 'sessions',
      label: 'Active sessions',
      value: String(activeSessions),
      tone: 'neutral',
      href: DEVICES_HREF,
    });
  }

  const policy = user.mfaPolicy;
  if (!policy) {
    items.push({
      id: 'org-mfa',
      label: 'Org two-factor',
      value: 'Not required',
      tone: 'neutral',
      href: canManageOrg ? ORG_MFA_SETTINGS_HREF : TOTP_ENROLMENT_HREF,
    });
  } else {
    const graceRunning = !policy.enforced && !!policy.graceUntil;
    items.push({
      id: 'org-mfa',
      label: 'Org two-factor',
      value: policy.enforced
        ? 'Required'
        : graceRunning ? `Required from ${formatDate(policy.graceUntil)}` : 'Required',
      // Required and you have nothing to meet it with is the one real problem.
      tone: hasSecondFactor ? 'good' : 'warn',
      href: hasSecondFactor && canManageOrg ? ORG_MFA_SETTINGS_HREF : PASSKEY_ENROLMENT_HREF,
      detail: hasSecondFactor ? undefined : 'You have no passkey or authenticator app yet',
    });
  }

  if (sso !== undefined) {
    items.push({
      id: 'sso',
      label: 'Org SSO',
      value: sso === null ? 'Not configured' : sso.enabled ? 'Configured' : 'Configured, disabled',
      tone: sso?.enabled ? 'good' : 'neutral',
      href: ORG_SSO_SETTINGS_HREF,
    });
  } else if (f?.providers.some((p) => p.type === 'sso' && p.orgId === user.organizationId)) {
    // Without admin access the org's IdP config is not readable; what IS known
    // is that this account has signed in through it.
    items.push({
      id: 'sso',
      label: 'Org SSO',
      value: 'Linked to your account',
      tone: 'good',
      href: FACTORS_HREF,
    });
  }

  return items;
}

/**
 * At-a-glance summary of the signed-in user's own security posture, shown at
 * the top of the Security page. Each item links to the tab/section that
 * changes it. Reads the same endpoints the sections below use.
 */
export function SecurityPostureStrip({ user }: { user: User }) {
  const hasTotp = !!user.authFactors?.hasTotp;
  const orgId = user.organizationId;
  const canManageOrg = hasPermission(user, 'org:settings');
  const ssoGate = useFeatureGate('sso');
  const canReadSso = !!orgId && hasPermission(user, 'org:idp') && ssoGate.isLoaded && ssoGate.entitled;

  const totp = useFetch(
    async () => (hasTotp ? (await api.getTotpStatus()).data?.totp ?? null : null),
    [hasTotp],
  );
  const sessions = useFetch(
    async () => (await api.listSessions()).data?.sessions ?? null,
    [],
  );
  const sso = useFetch(
    async (signal) => (canReadSso ? { config: (await api.getOwnOrgIdpConfig(orgId!, { signal })).data?.config ?? null } : null),
    [canReadSso, orgId],
  );

  const items = derivePosture({
    user,
    recoveryCodes: totp.data?.enabled
      ? { remaining: totp.data.recoveryCodesRemaining, total: totp.data.recoveryCodesTotal }
      : null,
    activeSessions: sessions.data ? sessions.data.length : null,
    // A failed or not-yet-loaded read is "unknown" — the item is left out
    // rather than guessed.
    sso: canReadSso && sso.data ? (sso.data.config ? { enabled: sso.data.config.enabled } : null) : undefined,
    canManageOrg,
  });

  if (items.length === 0) return null;

  return (
    <nav aria-label="Security posture" className="rounded-xl border border-default bg-surface p-2">
      <ul className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-1">
        {items.map((item) => {
          const Icon = TONE_ICON[item.tone];
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                className="flex h-full flex-col gap-0.5 rounded-lg px-3 py-2 hover:bg-surface-muted transition-colors"
                data-testid={`posture-${item.id}`}
              >
                <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">{item.label}</span>
                <span className={`inline-flex items-center gap-1 text-sm font-semibold ${TONE_CLASS[item.tone]}`}>
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="text-fg">{item.value}</span>
                </span>
                {item.detail && <span className="text-xs text-fg-muted">{item.detail}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Switch } from '@/components/ui/Switch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgIdpConfigDto } from '@/types';

/** Why "SSO required" can't be switched on yet, or null when it can. */
export function ssoRequiredBlocker(config: OrgIdpConfigDto): string | null {
  if (!config.enabled) return 'Enable the connection first.';
  if (!config.lastTest) return 'Run a successful test connection first.';
  if (!config.lastTest.ok) return 'The last test connection failed — fix it and test again.';
  if (config.lastTest.protocol !== config.protocol) return 'Test the connection on its current protocol first.';
  return null;
}

/**
 * The org policy "SSO required": people in the org's verified domains must sign
 * in through the IdP — their password, passkey and social sign-ins are refused.
 *
 * BREAK-GLASS: organization OWNERS are exempt and always keep their own
 * sign-in methods, so a broken IdP can never lock the organization out of
 * fixing it. Switching ON is only possible once the connection is enabled and a
 * test connection has succeeded against the current settings (enforced by the
 * server too); switching OFF is always possible. Both need the strong step-up
 * every IdP write needs.
 */
export function SsoRequiredToggle({
  orgId,
  config,
  readOnly,
  onSaved,
}: {
  orgId: string;
  config: OrgIdpConfigDto;
  readOnly: boolean;
  onSaved: (config: OrgIdpConfigDto) => void;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocker = config.ssoRequired ? null : ssoRequiredBlocker(config);

  const save = async (stepUpToken: string) => {
    const next = pending;
    setPending(null);
    if (next === null) return;
    setError(null);
    try {
      const res = await api.patchOwnOrgIdpConfig(orgId, { ssoRequired: next }, stepUpToken);
      if (res.data?.config) onSaved(res.data.config);
    } catch (err) {
      setError(formatError(err, 'Could not change the single sign-on requirement'));
    }
  };

  return (
    <div className="space-y-2" data-testid="sso-required">
      <div className="flex items-start gap-3">
        <Switch
          id="sso-required"
          checked={config.ssoRequired}
          disabled={readOnly || !!blocker}
          onChange={(v) => setPending(v)}
          aria-label="Require single sign-on"
        />
        <div className="text-sm">
          <label htmlFor="sso-required" className="font-medium">Require single sign-on</label>
          <p className="text-xs text-fg-muted">
            People whose email is in one of your verified domains must sign in through your identity provider —
            password, passkey and social sign-in are refused for them. <strong>Organization owners are always
            exempt</strong> (the break-glass path): they keep their own sign-in methods in case the identity
            provider is unavailable.
          </p>
          {blocker && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{blocker}</p>}
        </div>
      </div>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {pending !== null && (
        <StepUpModal
          title={pending ? 'Require single sign-on?' : 'Stop requiring single sign-on?'}
          action={pending ? 'Require single sign-on for your verified domains' : 'Allow other sign-in methods again'}
          requireStrongFactor
          details={pending
            ? <p>Members in your verified domains will only be able to sign in through your identity provider. Owners keep their other sign-in methods.</p>
            : <p>Members will again be able to sign in with a password, passkey or social login.</p>}
          onConfirmed={save}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}

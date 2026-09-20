// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { Switch } from '@/components/ui/Switch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { OrgIdpConfigDto } from '@/types';

/**
 * Turn the SSO connection on or off (`PATCH /organization/:id/idp` `{ enabled }`,
 * strong step-up). Disabling keeps every setting for a quick switch back; to
 * remove the connection entirely, use Disconnect.
 */
export function SsoEnableToggle({
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

  const save = async (stepUpToken: string) => {
    const next = pending;
    setPending(null);
    if (next === null) return;
    setError(null);
    try {
      const res = await api.patchOwnOrgIdpConfig(orgId, { enabled: next }, stepUpToken);
      if (res.data?.config) onSaved(res.data.config);
    } catch (err) {
      setError(formatError(err, next ? 'Could not enable single sign-on' : 'Could not disable single sign-on'));
    }
  };

  return (
    <div className="space-y-2" data-testid="sso-enabled">
      <div className="flex items-start gap-3">
        <Switch
          id="sso-enabled"
          checked={config.enabled}
          disabled={readOnly}
          onChange={(v) => setPending(v)}
          aria-label="Enable single sign-on"
        />
        <div className="text-sm">
          <label htmlFor="sso-enabled" className="font-medium">Enable single sign-on</label>
          <p className="text-xs text-fg-muted">
            Offers &ldquo;Continue with single sign-on&rdquo; to people in your verified domains. Other sign-in
            methods keep working unless you also require single sign-on.
          </p>
        </div>
      </div>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {pending !== null && (
        <StepUpModal
          action={pending ? 'Enable single sign-on for your organization' : 'Disable single sign-on for your organization'}
          requireStrongFactor
          onConfirmed={save}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}

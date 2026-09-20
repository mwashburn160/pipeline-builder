// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Unplug } from 'lucide-react';
import api from '@/lib/api';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { useToast } from '@/components/ui/Toast';
import { StepUpModal } from '@/components/admin/StepUpModal';
import { formatError } from '@/lib/constants';
import type { OrgIdpConfigDto } from '@/types';

/**
 * Remove the org's SSO connection (`DELETE /organization/:id/idp`).
 *
 * Distinct from switching single sign-on off: disabling keeps the connection (and its
 * secret, certificates and mappings' target) for a quick switch back, while
 * disconnecting deletes it — re-connecting means entering it again.
 *
 * ONE dialog confirms and steps up (the route demands a strong factor): it
 * states what members will experience, because that is what an admin needs to
 * know before pressing it, and takes the passkey / authenticator code the
 * delete is gated on.
 */
export function SsoDisconnect({
  orgId,
  config,
  readOnly,
  onDisconnected,
}: {
  orgId: string;
  config: OrgIdpConfigDto;
  readOnly: boolean;
  onDisconnected: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = async (stepUpToken: string) => {
    setConfirming(false);
    setError(null);
    try {
      await api.deleteOwnOrgIdpConfig(orgId, stepUpToken);
      toast.success('SSO disconnected');
      onDisconnected();
    } catch (err) {
      setError(formatError(err, 'Failed to disconnect SSO'));
    }
  };

  const protocol = config.protocol === 'saml' ? 'SAML' : 'OIDC';

  return (
    <SectionCard
      icon={Unplug}
      title="Disconnect SSO"
      description="Remove this organization's identity-provider connection entirely. It also removes the test result and the SSO-required policy. To pause SSO without losing the settings, switch it off instead."
    >
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <Button
        variant="danger"
        readOnly={readOnly}
        onClick={() => setConfirming(true)}
        className={error ? 'mt-3' : ''}
      >
        <Unplug className="w-4 h-4 mr-2" />Disconnect SSO
      </Button>

      {confirming && (
        <StepUpModal
          title="Disconnect SSO?"
          action={`Delete this organization's ${protocol} connection`}
          requireStrongFactor
          details={(
            <div className="space-y-2">
              <p>
                This deletes the {protocol} connection
                {config.protocol === 'saml' ? '' : `${config.provider ? ` to ${config.provider}` : ''}`}
                {config.hasClientSecret ? ', including its stored client secret' : ''}.
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Members can no longer sign in through your identity provider, and &ldquo;SSO required&rdquo; stops applying. They fall back to their other sign-in methods — a password, a passkey, or a social login they have linked.</li>
                <li>Members who have only ever signed in through SSO have no other method, and can&apos;t sign in until a platform administrator sets a password for them.</li>
                <li>Group → role mappings stop applying. Roles they already granted are not removed automatically.</li>
              </ul>
              <p>Reconnecting later means entering the connection details again.</p>
            </div>
          )}
          onConfirmed={disconnect}
          onClose={() => setConfirming(false)}
        />
      )}
    </SectionCard>
  );
}

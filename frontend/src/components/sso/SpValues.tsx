// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CopyButton } from '@/components/ui/CopyButton';
import { ReadonlyField } from '@/components/ui/ReadonlyField';
import { RetryError } from '@/components/ui/RetryError';
import { LoadingSpinner } from '@/components/ui/Loading';
import type { IdpProtocol } from '@/types';
import { useSsoSpInfo } from './useSsoSpInfo';

/** One copyable value. */
function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-start gap-2">
        <ReadonlyField label={label} value={value} className="flex-1 min-w-0" valueClassName="font-mono text-xs break-all" />
        <div className="pt-5"><CopyButton text={value} /></div>
      </div>
      {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

/**
 * "Give these to your identity provider" — every value the IdP needs, fetched
 * from the server, each with a copy button (the metadata URL and the OIDC
 * redirect URI included).
 */
export function SpValues({ orgId, protocol }: { orgId: string; protocol: IdpProtocol }) {
  const { sp, loading, error, refetch } = useSsoSpInfo(orgId);

  if (error) return <RetryError message={error.message || 'Could not load the service-provider values'} onRetry={refetch} />;
  if (loading || !sp) return <LoadingSpinner />;

  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 p-3 space-y-3" data-testid="sp-values">
      <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Give these to your identity provider</p>
      {protocol === 'oidc' ? (
        <CopyRow
          label="Redirect (callback) URI"
          value={sp.oidcRedirectUri}
          hint="Register this exact URI as an allowed redirect / sign-in callback URL on the OIDC client."
        />
      ) : (
        <>
          <CopyRow label="Service provider entity ID (Audience)" value={sp.entityId} />
          <CopyRow label="Assertion Consumer Service (ACS) URL" value={sp.acsUrl} hint="Bind it to HTTP-POST." />
          <CopyRow label="Single Logout (SLO) URL" value={sp.sloUrl} hint="Accepts HTTP-Redirect and HTTP-POST. LogoutRequests must be signed." />
          <CopyRow
            label="SP metadata URL"
            value={sp.metadataUrl}
            hint="Most identity providers can import everything above — plus our signing (and, when enabled, encryption) certificate — from this document."
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-fg-muted">SP certificates</summary>
            <div className="mt-2 space-y-2">
              <CopyRow label="Our certificate for signed requests and single logout" value={sp.signingCertificate} />
              <CopyRow label="Our certificate for encrypted assertions" value={sp.encryptionCertificate} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}

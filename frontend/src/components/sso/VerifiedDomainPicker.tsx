// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadingSpinner } from '@/components/ui/Loading';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';

/** Where domains are verified (Settings → Organization). */
export const DOMAIN_SETTINGS_HREF = '/dashboard/settings?tab=organization';

/** The org's DNS-verified domains, or `null` when the caller may not list them. */
export function useVerifiedDomains(orgId: string): { domains: string[] | null; loading: boolean } {
  const res = useFetch(async (signal) => {
    try {
      const r = await api.listOrgDomains(orgId, { signal });
      return (r.data?.domains ?? []).filter((d) => d.verified).map((d) => d.domain);
    } catch {
      // Listing domains is `org:settings`; an `org:idp`-only role can't. The
      // server still enforces "verified only" on save.
      return null;
    }
  }, [orgId]);
  return { domains: res.data, loading: res.loading };
}

/**
 * Pick which of the org's VERIFIED domains the SSO connection serves — replaces
 * the old free-text "allowed domains" field. Nothing unverified can be picked
 * (and the server refuses one anyway): an unverified domain proves nothing, so
 * listing one only ever made the settings claim a restriction that admitted
 * nobody. Selecting none means "every verified domain".
 */
export function VerifiedDomainPicker({
  orgId,
  value,
  onChange,
  disabled,
}: {
  orgId: string;
  value: string[];
  onChange: (domains: string[]) => void;
  disabled?: boolean;
}) {
  const { domains, loading } = useVerifiedDomains(orgId);
  if (loading) return <LoadingSpinner size="sm" />;

  if (domains === null) {
    return (
      <Callout variant="neutral">
        {value.length > 0
          ? <>This connection is limited to <strong>{value.join(', ')}</strong>.</>
          : <>This connection serves every verified domain of the organization.</>}
        {' '}Changing the list needs the organization-settings permission.
      </Callout>
    );
  }

  if (domains.length === 0) {
    return (
      <Callout variant="warning" title="No verified domains yet">
        Single sign-on only serves email domains your organization has proven it owns.{' '}
        <Link href={DOMAIN_SETTINGS_HREF} className="underline">Verify a domain</Link>{' '}
        (a DNS TXT record), then come back to this step.
      </Callout>
    );
  }

  const stale = value.filter((d) => !domains.includes(d));
  const toggle = (domain: string) => onChange(
    value.includes(domain) ? value.filter((d) => d !== domain) : [...value, domain],
  );

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Verified domains served by this connection</legend>
      {domains.map((domain) => (
        <label key={domain} className="flex items-center gap-2 text-sm">
          <Checkbox checked={value.includes(domain)} onChange={() => toggle(domain)} aria-label={domain} />
          <span className="font-mono">{domain}</span>
        </label>
      ))}
      {stale.map((domain) => (
        <label key={domain} className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <Checkbox checked onChange={() => toggle(domain)} aria-label={`${domain} (not verified here)`} />
          <span className="font-mono">{domain}</span> — not among this organization&apos;s verified domains. It saves
          only while the account&apos;s root organization has it verified; otherwise untick it.
        </label>
      ))}
      <p className="text-xs text-fg-muted">
        Tick none to serve every verified domain. <Link href={DOMAIN_SETTINGS_HREF} className="underline">Manage domains</Link>.
      </p>
    </fieldset>
  );
}

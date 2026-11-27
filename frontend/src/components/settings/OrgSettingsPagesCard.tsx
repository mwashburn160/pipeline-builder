// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { ChevronRight, Fingerprint, Plug, Siren } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Badge } from '@/components/ui/Badge';
import { useFeatureGate } from '@/hooks/useFeatureGate';

export const SSO_SETTINGS_HREF = '/dashboard/settings/sso';
export const INCIDENT_REPORTING_HREF = '/dashboard/settings/incident-reporting';

interface Row {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  locked: boolean;
}

/**
 * Org settings that have a page of their own: single sign-on and incident
 * reporting. Each row shows only to whoever that page admits (the same gates as
 * the pages: `org_idp:write` for SSO, org admin for incident reporting). A row
 * whose entitlement isn't on the plan stays listed, marked, and still links:
 * the page renders its own upsell.
 */
export function OrgSettingsPagesCard({ showSso, showIncidents }: { showSso: boolean; showIncidents: boolean }) {
  const sso = useFeatureGate('sso');
  const incidents = useFeatureGate('advanced_reporting');
  const rows: Row[] = [
    ...(showSso ? [{
      href: SSO_SETTINGS_HREF, icon: Fingerprint, title: 'Single sign-on',
      description: 'Sign members in through your SAML or OIDC identity provider.', locked: sso.isLoaded && !sso.entitled,
    }] : []),
    ...(showIncidents ? [{
      href: INCIDENT_REPORTING_HREF, icon: Siren, title: 'Incident reporting',
      description: 'Feed incidents from PagerDuty, Datadog or Alertmanager into DORA change failure rate and time to restore.',
      locked: incidents.isLoaded && !incidents.entitled,
    }] : []),
  ];
  if (rows.length === 0) return null;
  return (
    <SectionCard icon={Plug} title="Integrations" description="Each is set up on a page of its own." bodyClassName="p-0">
      <ul className="divide-y divide-default">
        {rows.map((r) => (
          <li key={r.href}>
            <Link href={r.href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-muted/40 transition-colors">
              <r.icon className="w-4 h-4 text-fg-subtle shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-fg">
                  {r.title}
                  {r.locked && <Badge color="gray">Not on your plan</Badge>}
                </span>
                <span className="block text-xs text-fg-muted">{r.description}</span>
              </span>
              <ChevronRight className="w-4 h-4 text-fg-subtle shrink-0" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

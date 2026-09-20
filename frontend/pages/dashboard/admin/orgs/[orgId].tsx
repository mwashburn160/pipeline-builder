// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin org-detail page.
 *
 * Consolidates everything a sysadmin needs about a single org onto one
 * surface: identity (name, slug, description), tier, its place in the org →
 * team hierarchy (parent, teams, move), the member roster, KMS
 * binding, IdP / SSO config, seats, entitlements and quotas, and the
 * namespace-YAML / export / delete operations. Each card owns its own writes
 * (and their step-up); this shell owns the reads, each through `useFetch`, so a
 * card that changes something re-reads exactly what it changed.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ArrowLeft, KeyRound, ShieldCheck, Sparkles, Gauge } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { useUrlTab } from '@/hooks/useUrlTab';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { LoadingPage, LoadingSpinner } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { TabBar } from '@/components/ui/TabBar';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { CopyableId } from '@/components/ui/CopyableId';
import { RetryError } from '@/components/ui/RetryError';
import { OrgKmsConfigModal } from '@/components/admin/OrgKmsConfigModal';
import { OrgIdpConfigModal } from '@/components/admin/OrgIdpConfigModal';
import { OrgIdentityCard } from '@/components/admin/org-detail/OrgIdentityCard';
import { OrgHierarchyCard } from '@/components/admin/org-detail/OrgHierarchyCard';
import { OrgMemberRoster } from '@/components/admin/org-detail/OrgMemberRoster';
import { OrgSeatsCard } from '@/components/admin/org-detail/OrgSeatsCard';
import { OrgOperationsCard } from '@/components/admin/org-detail/OrgOperationsCard';
import { redactString } from '@/lib/redact';
import api from '@/lib/api';
import type { OrganizationDetail } from '@/lib/api/domains/organizations';

const ORG_TABS = [
  { id: 'configuration', label: 'Configuration' },
  { id: 'members', label: 'Members' },
  { id: 'entitlements', label: 'Entitlements' },
  { id: 'operations', label: 'Operations' },
] as const;
type OrgTab = (typeof ORG_TABS)[number]['id'];
const ORG_TAB_IDS: readonly OrgTab[] = ORG_TABS.map((t) => t.id);

/** A fail-soft read: a 403/404 (e.g. a non-root org has no seat pool) is "none". */
async function orNull<T>(read: Promise<{ data?: T }>): Promise<T | null> {
  try {
    return (await read).data ?? null;
  } catch {
    return null;
  }
}

/**
 * "These figures belong to the parent" — the note the pooled-at-root reads
 * (seats, entitlements, quotas) owe a team. Reads the org ON SCREEN, so a
 * sysadmin always sees that org's hierarchy, never their own.
 */
function PooledAtParent({ org, what }: { org: OrganizationDetail; what: string }) {
  return (
    <p className="text-xs text-fg-muted pt-2">
      {what} pool at the account root — these are{' '}
      <Link href={`/dashboard/admin/orgs/${org.parentOrgId}`} className="action-link">
        {org.parentOrgName ?? 'the parent organization'}
      </Link>
      &apos;s, shared with every team.
    </p>
  );
}

export default function OrgDetailPage() {
  const router = useRouter();
  const orgId = String(router.query.orgId || '');
  const { accessDenied, isReady, user, can } = useAuthGuard();
  const enabled = isReady && !!orgId;

  // Grouped into tabs so the page isn't one long scroll. Deep-linkable via
  // `?tab=` (separate from the `?orgId` route param).
  const [activeTab, changeTab] = useUrlTab<OrgTab>('tab', ORG_TAB_IDS, 'configuration');

  // The org itself — with a one-member roster: the Members tab pages the full
  // list on its own. This read is the only one that blocks the page.
  const orgQ = useFetch(
    async (signal) => (enabled ? (await api.getOrganization(orgId, { membersLimit: 1 }, { signal })).data ?? null : null),
    [enabled, orgId],
  );
  const kmsQ = useFetch(
    async (signal) => (enabled ? (await api.getOrgKmsConfig(orgId, { signal })).data ?? null : null),
    [enabled, orgId],
  );
  // Everything below is fail-soft: a failure renders the card's empty state
  // rather than blocking the core org detail.
  const idpQ = useFetch(
    async (signal) => (enabled ? (await orNull(api.getOrgIdpConfig(orgId, { signal })))?.config ?? null : null),
    [enabled, orgId],
  );
  const seatsQ = useFetch(
    (signal) => (enabled ? orNull(api.getOrganizationSeatUsage(orgId, { signal })) : Promise.resolve(null)),
    [enabled, orgId],
  );
  const featuresQ = useFetch(
    async (signal) => (enabled ? (await orNull(api.getOrganizationFeatureEntitlements(orgId, { signal })))?.featureEntitlements ?? [] : []),
    [enabled, orgId],
  );
  const quotasQ = useFetch(
    async (signal) => (enabled ? (await orNull(api.getOrgQuotas(orgId, { signal })))?.quota ?? null : null),
    [enabled, orgId],
  );

  const [showKms, setShowKms] = useState(false);
  const [showIdp, setShowIdp] = useState(false);

  const org = orgQ.data;
  const kms = kmsQ.data;
  const idp = idpQ.data;
  const features = featuresQ.data ?? [];

  // Deep-link from the IdP roster ("Edit" → `?edit=idp`) opens the IdP editor
  // directly. Handled once (ref guard) so closing it doesn't re-open it.
  const idpDeepLinkHandled = useRef(false);
  useEffect(() => {
    if (org && router.query.edit === 'idp' && !idpDeepLinkHandled.current) {
      idpDeepLinkHandled.current = true;
      setShowIdp(true);
    }
  }, [org, router.query.edit]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  return (
    <DashboardLayout
      title={org ? org.name : 'Organization'}
      subtitle="System-admin org detail"
      breadcrumbs={[
        { label: 'All Organizations', href: '/dashboard/organizations' },
        { label: org ? org.name : 'Organization' },
      ]}
      titleExtra={<Badge color="red">System Admin</Badge>}
    >
      <div className="mb-4">
        <Link href="/dashboard/organizations" className="action-link inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to organizations
        </Link>
      </div>

      {orgQ.error ? (
        <RetryError message={orgQ.error.message || 'Failed to load org details'} onRetry={orgQ.refetch} />
      ) : !org ? (
        <LoadingSpinner />
      ) : (
        <>
          <TabBar items={[...ORG_TABS]} activeId={activeTab} onSelect={(tabId) => changeTab(tabId as OrgTab)} className="mb-4" />

          {activeTab === 'configuration' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <OrgIdentityCard org={org} onChanged={orgQ.refetch} onShowMembers={() => changeTab('members')} />

              <OrgHierarchyCard org={org} onChanged={orgQ.refetch} />

              <Card>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-5 h-5 text-fg-muted" />
                    <h3 className="text-base font-semibold text-fg">Per-org KMS</h3>
                  </div>
                  {can('org:kms') && (
                    <button type="button" onClick={() => setShowKms(true)} className="action-link text-sm">
                      {kms?.configured ? 'Rotate / clear' : 'Configure'}
                    </button>
                  )}
                </div>
                {kmsQ.error ? (
                  <RetryError message="Failed to load the KMS binding" onRetry={kmsQ.refetch} />
                ) : kms?.configured ? (
                  <div className="text-sm">
                    <div className="text-fg-muted mb-1">Wrapping under operator CMK:</div>
                    {/* A KMS key ARN embeds the AWS account id; redact it before it
                        reaches the DOM or the clipboard (CopyableId copies `value`). */}
                    <CopyableId value={redactString(kms.keyId ?? '')} size="sm" />
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Falling back to the shared SECRET_ENCRYPTION_KEY master.
                    Configure to wrap this org&apos;s secrets under its own CMK.
                  </p>
                )}
              </Card>

              <Card>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-fg-muted" />
                    <h3 className="text-base font-semibold text-fg">SSO / IdP</h3>
                  </div>
                  {can('org:idp') && (
                    <button type="button" onClick={() => setShowIdp(true)} className="action-link text-sm">
                      {idp ? 'Edit / remove' : 'Configure'}
                    </button>
                  )}
                </div>
                {idp ? (
                  <dl className="text-sm space-y-1.5">
                    <div>
                      <dt className="text-fg-muted">Provider</dt>
                      {/* A SAML config has no named provider — it is identified by
                          its protocol and the IdP's entity ID (#4). */}
                      <dd><code className="text-xs">{idp.protocol === 'saml' ? 'saml' : idp.provider}</code> {idp.enabled ? <Badge color="green">enabled</Badge> : <Badge color="yellow">disabled</Badge>}</dd>
                    </div>
                    {idp.protocol === 'saml' ? (
                      <div>
                        <dt className="text-fg-muted">IdP entity ID</dt>
                        <dd className="break-all"><CopyableId value={idp.samlEntityId ?? ''} size="sm" /></dd>
                      </div>
                    ) : (
                      <div>
                        <dt className="text-fg-muted">Client ID</dt>
                        <dd><CopyableId value={idp.clientId ?? ''} size="sm" /></dd>
                      </div>
                    )}
                    {idp.discoveryUrl && (
                      <div>
                        <dt className="text-fg-muted">Discovery URL</dt>
                        <dd className="break-all"><CopyableId value={idp.discoveryUrl} size="sm" /></dd>
                      </div>
                    )}
                    {idp.allowedEmailDomains.length > 0 && (
                      <div>
                        <dt className="text-fg-muted">Allowed domains</dt>
                        <dd>{idp.allowedEmailDomains.join(', ')}</dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-fg-muted">
                    No SSO configured. Members sign in via password / OAuth defaults.
                  </p>
                )}
              </Card>
            </div>
          )}

          {activeTab === 'members' && <OrgMemberRoster orgId={org.id} />}

          {activeTab === 'entitlements' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <OrgSeatsCard org={org} seatUsage={seatsQ.data} onChanged={seatsQ.refetch} />

              {/* Read-only: the account's (root) pooled feature flags purchased
                  via tier + add-on bundles. */}
              <Card>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-5 h-5 text-fg-muted" />
                  <h3 className="text-base font-semibold text-fg">Feature entitlements</h3>
                </div>
                {features.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {features.map((f) => <Badge key={f} color="blue">{f}</Badge>)}
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">
                    No add-on feature entitlements. The org has only its tier&apos;s baseline features.
                  </p>
                )}
                {/* Both entitlements and quotas resolve to the ROOT. For a team
                    these are its parent's, not its own — say so on the org being
                    viewed rather than letting them read as the team's. */}
                {org.parentOrgId && <PooledAtParent org={org} what="Entitlements" />}
              </Card>

              {/* Usage vs limits from the quota service — the source of truth.
                  Limits are edited on the Quotas page. */}
              <Card>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Gauge className="w-5 h-5 text-fg-muted" />
                    <h3 className="text-base font-semibold text-fg">Quotas</h3>
                  </div>
                  <Link href="/dashboard/quotas" className="action-link text-sm">Manage</Link>
                </div>
                {quotasQ.data ? (
                  <dl className="text-sm space-y-1.5">
                    {Object.entries(quotasQ.data.quotas).map(([type, summary]) => (
                      <div key={type} className="flex justify-between">
                        <dt className="text-fg-muted">{type}</dt>
                        <dd className="font-mono text-xs">
                          {summary.used} / {summary.unlimited || summary.limit === -1 ? '∞' : summary.limit}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Quota usage unavailable — the quota service didn&apos;t respond.
                  </p>
                )}
                {org.parentOrgId && <PooledAtParent org={org} what="Limits" />}
              </Card>
            </div>
          )}

          {activeTab === 'operations' && <OrgOperationsCard org={org} />}
        </>
      )}

      {showKms && org && (
        <OrgKmsConfigModal org={org} onClose={() => { setShowKms(false); kmsQ.refetch(); }} onSaved={kmsQ.refetch} />
      )}

      {showIdp && org && (
        <OrgIdpConfigModal org={org} onClose={() => { setShowIdp(false); idpQ.refetch(); }} onSaved={idpQ.refetch} />
      )}
    </DashboardLayout>
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org's plugin-ecosystem PUBLISHER page.
 *
 * Tenants never decide anything in the ecosystem: everything here is the org's
 * public identity, its listings (which it may PAUSE — that only narrows its own
 * reach) and REQUESTS the system org's Ecosystem Managers decide.
 *
 * Read gate: `plugins:read` (the nav entry, via page-access). Writes are gated
 * per control — `publishers:manage` for the profile and profile/transfer/claim/
 * verify requests, `plugins:publish` for listing, version, yank, unpause and
 * listing-update requests and pausing — mirroring the server's per-kind checks.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { Send, Store } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useDebounce } from '@/hooks/useDebounce';
import { useFetch } from '@/hooks/useFetch';
import { useGroupedUrlTab } from '@/hooks/useGroupedUrlTab';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Callout } from '@/components/ui/Callout';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { LoadingPage } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { SectionCard } from '@/components/ui/SectionCard';
import { Select } from '@/components/ui/Select';
import { GroupedTabs, type GroupedTabItem } from '@/components/ui/GroupedTabs';
import { PublisherProfilePanel } from '@/components/publisher/PublisherProfilePanel';
import { PublisherListingsPanel } from '@/components/publisher/PublisherListingsPanel';
import { PublishRequestForm } from '@/components/publisher/PublishRequestForm';
import { PublishRequestsPanel } from '@/components/publisher/PublishRequestsPanel';
import { PublisherAdvisoriesPanel } from '@/components/publisher/PublisherAdvisoriesPanel';
import { PublisherInsightsPanel } from '@/components/publisher/PublisherInsightsPanel';
import { PublisherFixRequestsPanel } from '@/components/publisher/PublisherFixRequestsPanel';
import api from '@/lib/api';
import { queryTags } from '@/lib/api-cache';
import { formatError } from '@/lib/constants';
import { PUBLISHER_TABS, type PublisherSection, type PublisherTab } from '@/lib/page-tabs/publisher';
import type { PublisherContext } from '@/types/ecosystem';

/** Versions offered per search in the New request picker. */
const PICKER_PAGE = 50;

const TABS: readonly GroupedTabItem<PublisherTab, PublisherSection>[] = [
  { id: 'profile', label: 'Profile', name: 'Profile' },
  { id: 'listings', label: 'Listings', name: 'Listings', sections: [{ id: 'listings', label: 'Manage' }, { id: 'insights', label: 'Insights' }] },
  { id: 'requests', label: 'Requests', name: 'Requests', sections: [{ id: 'requests', label: 'All requests' }, { id: 'publish', label: 'New request' }] },
  { id: 'security', label: 'Security', name: 'Security', sections: [{ id: 'advisories', label: 'Advisories' }, { id: 'fixes', label: 'Fix requests' }] },
];
const TAB_PREFIX = 'publisher';

/** Pick one of the org's own plugin versions, then the draft-driven request form. */
function PublishTab({ orgId, initialPluginId, onSubmitted }: {
  orgId: string | undefined;
  initialPluginId: string | null;
  onSubmitted: () => void;
}) {
  // Filtered ON THE SERVER to this org's public versions, by name — filtering
  // one client-side page (the system catalog and other orgs' public ones
  // included) would hide own versions past that page.
  const [search, setSearch] = useState('');
  const query = useDebounce(search.trim(), 250);
  const pluginsQ = useFetch(async (signal) => {
    if (!orgId) return { plugins: [], total: 0 };
    const res = await api.listPlugins({
      orgId, visibility: 'public', limit: String(PICKER_PAGE), includeTotal: 'true',
      fields: 'id,orgId,name,version,visibility', ...(query ? { name: query } : {}),
    }, { signal });
    const rows = (res.data?.plugins ?? []).filter((p) => p.orgId === orgId && p.visibility === 'public');
    return { plugins: rows, total: res.data?.pagination?.total ?? rows.length };
  }, [orgId, query], { tags: [queryTags.plugins] });
  const [pluginId, setPluginId] = useState<string>(initialPluginId ?? '');
  const publicOnes = pluginsQ.data?.plugins ?? [];
  const truncated = (pluginsQ.data?.total ?? 0) > publicOnes.length;

  return (
    <SectionCard icon={Send} title="Submit to the ecosystem" description="Request a new listing, or a new version of an existing one. The ecosystem team reviews every request.">
      <div className="space-y-5">
        {pluginsQ.error ? (
          <RetryError message={formatError(pluginsQ.error, 'Failed to load your plugins')} onRetry={pluginsQ.refetch} />
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="Find a plugin" className="min-w-[14rem] flex-1">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Plugin name" autoComplete="off" />
            </FormField>
            <FormField
              label="Plugin version"
              className="min-w-[16rem] flex-1"
              hint={truncated
                ? `Showing the first ${publicOnes.length} of ${pluginsQ.data?.total} matches — type more of the name to narrow it.`
                : "Only public versions can be listed. Change a plugin's access to public on the Plugins page first."}
            >
              <Select value={pluginId} onChange={(e) => setPluginId(e.target.value)} disabled={pluginsQ.loading && !pluginsQ.data}>
                <option value="">{pluginsQ.loading && !pluginsQ.data ? 'Loading…' : publicOnes.length ? 'Choose a plugin version…' : query ? 'No public version matches' : 'No public plugin versions'}</option>
                {publicOnes.map((p) => <option key={p.id} value={p.id}>{p.name} v{p.version}</option>)}
                {/* A deep link to a version not in this page (or not public) still
                    opens its draft — the visibility gate there says why it can't
                    be submitted. */}
                {pluginId && !publicOnes.some((p) => p.id === pluginId) && (
                  <option value={pluginId}>Selected plugin</option>
                )}
              </Select>
            </FormField>
          </div>
        )}
        {pluginId && <PublishRequestForm key={pluginId} pluginId={pluginId} onSubmitted={() => { setPluginId(''); onSubmitted(); }} />}
      </div>
    </SectionCard>
  );
}

export default function PublisherPage() {
  const { accessDenied, user, isReady, can } = useAuthGuard();
  const router = useRouter();
  // `?tab=` and its `?section=` (PUBLISHER_TABS).
  const { tab, section, select } = useGroupedUrlTab(PUBLISHER_TABS);
  // The view: the tab itself, or its sub-tab.
  const view = section ?? tab;
  const initialPluginId = useMemo(() => {
    const raw = router.query.pluginId;
    return (Array.isArray(raw) ? raw[0] : raw) ?? null;
  }, [router.query.pluginId]);

  const ctxQ = useFetch(async (signal): Promise<PublisherContext | null> => {
    if (!isReady) return null;
    const res = await api.getPublisher({ signal });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to load the publisher');
    return res.data;
  }, [isReady, user?.organizationId]);

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  const canManage = can('publishers:manage');
  const canPublish = can('plugins:publish');
  const ctx = ctxQ.data;

  const body = () => {
    if (ctxQ.error) return <RetryError message={formatError(ctxQ.error, 'Failed to load the publisher')} onRetry={ctxQ.refetch} />;
    if (!ctx) return <LoadingPage />;
    const blocked = !ctx.publishingEnabled || !ctx.isRootOrg || !ctx.publisher;
    if (view === 'profile') {
      return <PublisherProfilePanel key={ctx.publisher?.updatedAt ?? 'none'} ctx={ctx} canManage={canManage} onChanged={ctxQ.refetch} />;
    }
    if (blocked) {
      return (
        <EmptyState
          icon={Store}
          title={!ctx.publishingEnabled ? 'Publishing is turned off' : !ctx.isRootOrg ? 'Publishing happens from your root organization' : 'No publisher yet'}
          description={!ctx.publishingEnabled
            ? 'Publishing to the plugin ecosystem is disabled on this instance.'
            : !ctx.isRootOrg
              ? 'Switch to your root organization to manage its publisher, listings and requests.'
              : 'Create your publisher on the Profile tab first.'}
        />
      );
    }
    if (view === 'listings') return <PublisherListingsPanel canPublish={canPublish} canManage={canManage} />;
    // Reading the org's advisories rides `plugins:read` (the server's gate);
    // REQUESTING one is `publishers:manage`, which the panel gates itself.
    if (view === 'advisories') {
      if (!can('plugins:read')) {
        return <Callout variant="neutral">Viewing your listings&apos; advisories needs the plugins:read permission.</Callout>;
      }
      return <PublisherAdvisoriesPanel canManage={canManage} />;
    }
    if (view === 'insights') return <PublisherInsightsPanel />;
    // Fix requests (N40) from nightly CVE remediation are delivered as notices
    // only (no stored list or route), so the tab points at where they arrive.
    if (view === 'fixes') return <PublisherFixRequestsPanel />;
    if (view === 'publish') {
      if (!canPublish) {
        return <Callout variant="neutral">Submitting listings and versions needs the plugins:publish permission.</Callout>;
      }
      if (!ctx.terms.accepted) {
        return <Callout variant="warning">Accept the current publisher terms on the Profile tab before submitting requests.</Callout>;
      }
      return <PublishTab orgId={user.organizationId} initialPluginId={initialPluginId} onSubmitted={() => select('requests', 'requests')} />;
    }
    return <PublishRequestsPanel canPublish={canPublish} canManage={canManage} />;
  };

  return (
    <DashboardLayout title="Publisher" subtitle="Your organization's identity and listings in the public plugin directory">
      <GroupedTabs items={TABS} tab={tab} section={section} onSelect={select} idPrefix={TAB_PREFIX} ariaLabel="Publisher sections">
        {body()}
      </GroupedTabs>
    </DashboardLayout>
  );
}

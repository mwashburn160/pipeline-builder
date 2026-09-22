// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org's plugin-ecosystem PUBLISHER page (plan §3.0, §3.1, §3.1a, §3.4).
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
import { useUrlTab } from '@/hooks/useUrlTab';
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
import { TabBar, tabPanelProps } from '@/components/ui/TabBar';
import { PublisherProfilePanel } from '@/components/publisher/PublisherProfilePanel';
import { PublisherListingsPanel } from '@/components/publisher/PublisherListingsPanel';
import { PublishRequestForm } from '@/components/publisher/PublishRequestForm';
import { PublishRequestsPanel } from '@/components/publisher/PublishRequestsPanel';
import { PublisherAdvisoriesPanel } from '@/components/publisher/PublisherAdvisoriesPanel';
import { PublisherInsightsPanel } from '@/components/publisher/PublisherInsightsPanel';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { PublisherContext } from '@/types/ecosystem';

/** Versions offered per search in the Publish tab's picker. */
const PICKER_PAGE = 50;

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'listings', label: 'Listings' },
  { id: 'insights', label: 'Insights' },
  { id: 'publish', label: 'Publish' },
  { id: 'requests', label: 'Requests' },
  { id: 'advisories', label: 'Advisories' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = TABS.map((t) => t.id) as TabId[];
const TAB_PREFIX = 'publisher';

/** Pick one of the org's own plugin versions, then the draft-driven request form. */
function PublishTab({ orgId, initialPluginId, onSubmitted }: {
  orgId: string | undefined;
  initialPluginId: string | null;
  onSubmitted: () => void;
}) {
  // Filtered ON THE SERVER to this org's public versions, by name. It used to
  // take the first 200 plugins the caller could see (the system catalog and
  // other orgs' public ones included) and filter here — so an org whose own
  // public versions sat past that page could not pick them at all.
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
  }, [orgId, query]);
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
  const [tab, setTab] = useUrlTab<TabId>('tab', TAB_IDS, 'profile');
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
    if (tab === 'profile') {
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
    if (tab === 'listings') return <PublisherListingsPanel canPublish={canPublish} canManage={canManage} />;
    // Reading the org's advisories rides `plugins:read` (the server's gate);
    // REQUESTING one is `publishers:manage`, which the panel gates itself.
    if (tab === 'advisories') {
      if (!can('plugins:read')) {
        return <Callout variant="neutral">Viewing your listings&apos; advisories needs the plugins:read permission.</Callout>;
      }
      return <PublisherAdvisoriesPanel canManage={canManage} />;
    }
    if (tab === 'insights') return <PublisherInsightsPanel />;
    if (tab === 'publish') {
      if (!canPublish) {
        return <Callout variant="neutral">Submitting listings and versions needs the plugins:publish permission.</Callout>;
      }
      if (!ctx.terms.accepted) {
        return <Callout variant="warning">Accept the current publisher terms on the Profile tab before submitting requests.</Callout>;
      }
      return <PublishTab orgId={user.organizationId} initialPluginId={initialPluginId} onSubmitted={() => setTab('requests')} />;
    }
    return <PublishRequestsPanel canPublish={canPublish} canManage={canManage} />;
  };

  return (
    <DashboardLayout title="Publisher" subtitle="Your organization's identity and listings in the public plugin directory">
      <TabBar
        items={TABS}
        activeId={tab}
        onSelect={(id) => setTab(id as TabId)}
        idPrefix={TAB_PREFIX}
        ariaLabel="Publisher sections"
        className="mb-4"
      />
      <div {...tabPanelProps(TAB_PREFIX, tab)}>{body()}</div>
    </DashboardLayout>
  );
}

import { useState, useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useToast } from '@/components/ui/Toast';
import { useOpenOnCreateQuery } from '@/hooks/useOpenOnCreateQuery';
import { formatError } from '@/lib/constants';
import { Plus, Upload } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useFeatureGate } from '@/hooks/useFeatureGate';
import { useDelete } from '@/hooks/useDelete';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { RoleBanner } from '@/components/ui/RoleBanner';
import { DeleteConfirmModal } from '@/components/ui/DeleteConfirmModal';
import { Button } from '@/components/ui/Button';
import { PluginDetailModal } from '@/components/plugin/PluginDetailModal';
import { PluginLifecycleModal, type PluginLifecycleAction } from '@/components/plugin/PluginLifecycleModal';
import { usePluginColumns } from '@/components/plugin/usePluginColumns';
import { BulkActionBar } from '@/components/dashboard/BulkActionBar';
import api from '@/lib/api';
import type { PluginSummary } from '@/lib/api/domains/plugins';
import { canModify } from '@/lib/resource-helpers';
import { visitedPluginsKey } from '@/lib/onboarding';
import { useFavorites } from '@/lib/favorites';
import { useUrlTab } from '@/hooks/useUrlTab';
import { useGroupedUrlTab } from '@/hooks/useGroupedUrlTab';
import { GroupedTabs, type GroupedTabItem } from '@/components/ui/GroupedTabs';
import { PLUGINS_TABS, resolvePluginsTab, type PluginsSection, type PluginsTab } from '@/lib/page-tabs/plugins';
import { settleTabLocation, SECTION_KEY } from '@/lib/page-tabs/grouped';
import { CatalogTab } from '@/components/plugin-installs/CatalogTab';
import { InstallsTab } from '@/components/plugin-installs/InstallsTab';
import { OrgFailedBuildsPanel } from '@/components/plugin/OrgFailedBuildsPanel';
import { PluginInUseModal, pluginInUseRefusal, type PluginInUseRefusal } from '@/components/plugin/PluginInUseModal';
import { DeletePluginDialog, usePluginDeleteJobWatcher } from '@/components/plugin/DeletePluginDialog';
import { TidyKeepBanner } from '@/components/plugin/PluginTidyControls';
import { MyPluginsTab } from '@/components/plugin/tabs/MyPluginsTab';
import { PluginSecurityTab, SECURITY_SECTIONS } from '@/components/plugin/tabs/PluginSecurityTab';
import { useMyPluginsList } from '@/components/plugin/tabs/useMyPluginsList';
import { usePluginBulkActions } from '@/components/plugin/tabs/usePluginBulkActions';
import { usePluginLookups } from '@/components/plugin/tabs/usePluginLookups';
import { isSystemOrgActive } from '@/lib/ecosystem-access';
import { pluginPagePath } from '@/lib/public-directory/links';
import type { ListingState } from '@/types/ecosystem';

// Modals load on first use — none of them is part of the list's first paint,
// and the create modal carries the AI builder.
const CreatePluginModal = dynamic(() => import('@/components/plugin/CreatePluginModal'), { ssr: false });
const EditPluginModal = dynamic(() => import('@/components/plugin/EditPluginModal'), { ssr: false });

// ─── Page ───────────────────────────────────────────────

/** Plugin management page. Lists, creates, edits, and deletes plugins with filtering by type, compute, and access. */
/** The two states of the list, as the query string spells them. */
const DELETED_VIEWS = ['active', 'deleted'] as const;

/** Listing states the public directory serves (see the `public_listings` view). */
const PUBLIC_LISTING_STATES: ReadonlySet<ListingState> = new Set<ListingState>(['listed', 'unmaintained']);

export default function PluginsPage() {
  const { accessDenied, user, isReady, isAuthenticated, isSuperAdmin, isOrgAdminUser, isAdmin, can } = useAuthGuard();
  const toast = useToast();
  const canViewPublic = isSuperAdmin;
  // Fine-grained RBAC: write controls (create/upload/edit/delete/bulk/select)
  // unlock on `plugins:write`, not org-admin role, so a custom-group member
  // granted the capability gets them too. Role-admins hold it in their bundle.
  const canWrite = can('plugins:write');
  // Publishing (making a plugin PUBLIC) is a distinct capability the backend
  // gates upload/update/delete/bulk on — mirror the pipelines pattern
  // (`can('pipelines:publish')`), so a custom-group member granted
  // `plugins:publish` can publish. Superadmins bypass.
  const canPublish = can('plugins:publish');
  // Ecosystem consumption: installing listings, and the org-local
  // consumption policy + install approvals.
  const canInstall = can('plugins:install');
  const canManageInstalls = can('plugin_installs:manage');
  const router = useRouter();
  // Tabs (`?tab=`, Security's sub-tab in `?section=`), per PLUGINS_TABS.
  // Approvals is an approver's surface; a hand-edited URL can't open it.
  // Builds: the queue routes need plugins:write (and scope a tenant to its own org's jobs).
  const tabVisibility = {
    tabs: (Object.keys(PLUGINS_TABS.groups) as PluginsTab[]).filter((t) => t !== 'builds' || canWrite),
    sections: (t: PluginsTab) => PLUGINS_TABS.groups[t].filter((sec) => sec !== 'approvals' || canManageInstalls),
  };
  const { tab, section, select: selectTab } = useGroupedUrlTab(PLUGINS_TABS, tabVisibility);
  // The own-plugin list's URL write-back replaces the whole query, so it must
  // not start unless the URL itself names My plugins — or it drops `?tab=`.
  const firstOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const mineActive = tab === 'mine'
    && settleTabLocation(PLUGINS_TABS, resolvePluginsTab(firstOf(router.query.tab), firstOf(router.query[SECTION_KEY])), tabVisibility).tab === 'mine';
  // Batch activate/deactivate/delete is a tier-gated feature: the backend
  // attaches `requireFeature('bulk_operations')` to the bulk routes, so without
  // the flag every bulk action 403s. The backend ALSO gates bulk delete/update
  // on `plugins:publish`, so a write-but-not-publish member would 403 too —
  // include `canPublish` so we don't surface controls guaranteed to fail.
  const bulkGate = useFeatureGate('bulk_operations');
  const canBulk = canWrite && canPublish && bulkGate.entitled;

  // Row write gate — mirrors the backend's requireVisibilityWriteAccess so the
  // UI never offers an action the API refuses.
  const userId = user?.id;
  const canWriteRow = useCallback(
    (p: { visibility?: string; createdBy?: string; orgId?: string }) => canWrite && canModify(p, { isSuperAdmin, canPublish, userId, orgId: user?.organizationId }),
    [canWrite, isSuperAdmin, canPublish, userId, user?.organizationId],
  );

  // Mark the "explore plugin catalog" onboarding step as complete on first visit.
  useEffect(() => {
    if (typeof window === 'undefined' || !user?.organizationId) return;
    try { localStorage.setItem(visitedPluginsKey(user.organizationId), '1'); } catch { /* localStorage may be unavailable */ }
  }, [user?.organizationId]);

  // Favorited plugin IDs for this user in this org. The preferences store
  // paints from its local cache, reconciles with the server once per page load,
  // and never lets that load revert a toggle made while it was in flight.
  const { favorites, toggle: handleToggleFavorite } = useFavorites(user?.id, user?.organizationId);

  // Usage counts, shadowing, and the org's own listings (all non-blocking).
  const { pluginUsage, shadowedById, listedVersions } = usePluginLookups(isAuthenticated, canPublish);

  // ── Data ──

  // The "My plugins" list (see useMyPluginsList): page-owned so it survives a tab switch.
  const mine = useMyPluginsList({ isAuthenticated, mineActive, favorites, seedQuery: router.query.q });
  const { list, refreshList, afterWrite } = mine;

  // A version pipelines still reference is never deleted: the 409 names them
  // (with the version to move to), shown in its own dialog rather than an error line.
  const [inUse, setInUse] = useState<PluginInUseRefusal | null>(null);
  // "Delete plugin (all versions)": the name whose delete preview dialog is open.
  const [deleteAllName, setDeleteAllName] = useState<string | null>(null);
  // A whole-plugin delete whose dialog was closed mid-run: watched here so the
  // list still refreshes when it ends (stops with the page).
  const watchDeleteJob = usePluginDeleteJobWatcher({
    onDeleted: (r) => { setViewPlugin((v) => (v?.name === r.name ? null : v)); afterWrite(); toast.success(`Deleted ${r.deleted.length} version${r.deleted.length === 1 ? '' : 's'} of ${r.name}`); },
    onFailed: (n, message) => toast.error(`${n}: ${message}`),
  });
  const deletingRef = useRef<PluginSummary | null>(null);
  const del = useDelete<PluginSummary>(
    (p) => { deletingRef.current = p; return api.deletePlugin(p.id); },
    () => { afterWrite(); toast.success('Plugin deleted'); },
    (err) => {
      const p = deletingRef.current;
      const refusal = p ? pluginInUseRefusal(err, { name: p.name, version: p.version }) : null;
      if (refusal) setInUse(refusal);
      else list.setError(formatError(err, 'Failed to delete plugin'));
    },
  );

  // Active vs. Recently-deleted view (tabs); the tab is write-gated like restore.
  // In the URL: the deleted view is where someone goes to RESTORE something, so
  // "here is the one that got deleted" needs to be a link, and a refresh after a
  // restore should not bounce back to the active list.
  const [deletedView, setDeletedView] = useUrlTab<'active' | 'deleted'>('view', DELETED_VIEWS, 'active');

  // ── Bulk Operations ──

  const { selection, selectedIds, clearSelection, bulkLoading, showBulkDelete, setShowBulkDelete, handleBulkDelete, handleBulkActivate } = usePluginBulkActions({ afterWrite, setError: list.setError });

  // ── Modals ──

  const [showAdvanced, setShowAdvanced] = useState(false);
  // CreatePluginModal is a tabbed surface (AI Builder + Upload). The two
  // toolbar buttons just pick which tab to open it on; only one modal exists.
  const [createInitialTab, setCreateInitialTab] = useState<'upload' | 'ai' | null>(null);
  const [editPlugin, setEditPlugin] = useState<PluginSummary | null>(null);
  const [viewPlugin, setViewPlugin] = useState<PluginSummary | null>(null);
  // A remediation names a version by id (the flagged one, its fix): load it into the detail view.
  const openPluginById = useCallback(async (id: string) => {
    try {
      const res = await api.getPluginById(id);
      if (res.data?.plugin) setViewPlugin(res.data.plugin);
    } catch (err) {
      toast.error(formatError(err, 'Could not open the plugin'));
    }
  }, [toast]);
  // Deprecate / clear deprecation / yank a version — one confirm dialog.
  const [lifecycleTarget, setLifecycleTarget] = useState<{ plugin: PluginSummary; action: PluginLifecycleAction } | null>(null);
  const openLifecycle = useCallback((plugin: PluginSummary, action: PluginLifecycleAction) => setLifecycleTarget({ plugin, action }), []);

  // Open the create modal when arrived via a deep link: the sidebar "Add Plugin"
  // shortcut (`?create=1`) lands on the AI Builder tab, while `?create=upload`
  // lands on Upload — that is the link a build blocked by the vulnerability gate
  // offers, where the only way forward is a new image rather than a retry.
  useOpenOnCreateQuery((value) => {
    if (canWrite) setCreateInitialTab(value === 'upload' ? 'upload' : 'ai');
  }, isReady && !!user);

  // ── Columns ──

  const openDelete = del.open;
  const pluginColumns = usePluginColumns({
    selectable: canBulk,
    selectedIds,
    onToggleSelect: selection.toggle,
    favorites,
    onToggleFavorite: handleToggleFavorite,
    usage: pluginUsage,
    shadowed: shadowedById,
    canWriteRow,
    showRegistryLink: isSuperAdmin,
    onView: setViewPlugin,
    onEdit: setEditPlugin,
    onDelete: openDelete,
    onLifecycle: openLifecycle,
  });

  // ── Render ──

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !user) return <LoadingPage />;

  // The detail modal's ecosystem links, for an OWN version (the listings are
  // this org's publisher's): a version already listed links to its public page
  // (while the directory serves the listing) and is never offered for publishing
  // again; an unlisted public version is.
  const viewOwn = !!viewPlugin && viewPlugin.orgId === user.organizationId;
  const viewListing = viewOwn ? listedVersions.get(`${viewPlugin.name}@${viewPlugin.version}`) : undefined;
  const viewPublicUrl = viewListing && PUBLIC_LISTING_STATES.has(viewListing.state) && !viewListing.pausedAt
    ? pluginPagePath(viewListing.publisherHandle, viewListing.name)
    : undefined;
  const viewPublishHref = canPublish && viewOwn && !viewListing && viewPlugin.visibility === 'public'
    ? `/dashboard/publisher?tab=requests&section=publish&pluginId=${encodeURIComponent(viewPlugin.id)}`
    : undefined;


  return (
    <DashboardLayout
      title="Plugins"
      subtitle="Manage build and deploy plugins"
      actions={
        canWrite ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setCreateInitialTab('upload')}>
              <Upload className="w-4 h-4 mr-1.5" />
              Upload Plugin
            </Button>
            <Button onClick={() => setCreateInitialTab('ai')}>
              <Plus className="w-4 h-4 mr-1.5" />
              Create Plugin
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="page-section">
        <RoleBanner isSuperAdmin={isSuperAdmin} resourceName="plugins" size="sm" />
        <TidyKeepBanner
          pluginId={typeof router.query.tidyKeep === 'string' ? router.query.tidyKeep : undefined}
          canWrite={canWrite}
          onDone={() => { const { tidyKeep: _k, ...query } = router.query; void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true }); }}
        />

        <GroupedTabs
          ariaLabel="Plugin sections"
          idPrefix="plugins"
          items={[
            { id: 'mine', label: 'My plugins', name: 'My plugins' },
            { id: 'catalog', label: 'Catalog', name: 'Catalog' },
            { id: 'installs', label: 'Installs', name: 'Installs' },
            { id: 'security', label: 'Security', name: 'Security', sections: SECURITY_SECTIONS.filter((x) => x.id !== 'approvals' || canManageInstalls) },
            ...(canWrite ? [{ id: 'builds' as const, label: 'Builds', name: 'Builds' }] : []),
          ] satisfies GroupedTabItem<PluginsTab, PluginsSection>[]}
          tab={tab}
          section={section}
          onSelect={selectTab}
        >
        {tab === 'catalog' && (
          <CatalogTab
            canInstall={canInstall}
            usage={pluginUsage}
            initialQuery={typeof router.query.q === 'string' ? router.query.q : ''}
          />
        )}
        {tab === 'installs' && <InstallsTab canInstall={canInstall} usage={pluginUsage} />}
        <PluginSecurityTab
          section={section}
          canManageInstalls={canManageInstalls}
          canWrite={canWrite}
          isSystemOrg={isSystemOrgActive(user)}
          focusRemediationId={typeof router.query.remediation === 'string' ? router.query.remediation : undefined}
          onOpenPlugin={openPluginById}
        />
        {tab === 'builds' && canWrite && (
          <OrgFailedBuildsPanel seesEveryOrg={isSystemOrgActive(user) && can('plugin_queue:manage')} />
        )}

        {tab === 'mine' && (
          <MyPluginsTab
            mine={mine}
            columns={pluginColumns}
            canWrite={canWrite}
            canViewPublic={canViewPublic}
            canBulk={canBulk}
            selectedCount={selectedIds.size}
            canWriteRow={canWriteRow}
            deletedView={deletedView}
            onDeletedViewChange={setDeletedView}
            showAdvanced={showAdvanced}
            onShowAdvancedChange={setShowAdvanced}
            onCreate={() => setCreateInitialTab('ai')}
          />
        )}
        </GroupedTabs>
      </div>

      {createInitialTab && (
        <CreatePluginModal
          canPublish={canPublish}
          initialTab={createInitialTab}
          onClose={() => setCreateInitialTab(null)}
          onCreated={afterWrite}
        />
      )}

      {del.target && (
        <DeleteConfirmModal title="Delete version" itemName={`${del.target.name}@${del.target.version}`} loading={del.loading} onConfirm={del.confirm} onCancel={del.close} />
      )}

      {inUse && <PluginInUseModal refusal={inUse} onClose={() => setInUse(null)} />}

      {deleteAllName && (
        <DeletePluginDialog name={deleteAllName} onClose={() => setDeleteAllName(null)} onDeleted={() => { setViewPlugin(null); afterWrite(); }} onContinueInBackground={watchDeleteJob} />
      )}

      {lifecycleTarget && (
        <PluginLifecycleModal
          plugin={lifecycleTarget.plugin}
          action={lifecycleTarget.action}
          onClose={() => setLifecycleTarget(null)}
          onDone={afterWrite}
          canOperateToolchain={isSystemOrgActive(user) && can('toolchain:operate')}
        />
      )}

      {showBulkDelete && (
        <DeleteConfirmModal
          title="Delete plugins"
          itemName={`${selectedIds.size} plugin${selectedIds.size > 1 ? 's' : ''}`}
          loading={bulkLoading}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowBulkDelete(false)}
        />
      )}

      {editPlugin && (
        <EditPluginModal plugin={editPlugin} canPublish={canPublish} onClose={() => setEditPlugin(null)} onSaved={refreshList} />
      )}

      {viewPlugin && (
        <PluginDetailModal
          plugin={viewPlugin}
          shadows={shadowedById.get(viewPlugin.id) ?? null}
          showRegistryLink={isSuperAdmin}
          onClose={() => setViewPlugin(null)}
          remediation={{ canWrite, isSystemOrg: isSystemOrgActive(user), onOpenPlugin: openPluginById }}
          showStorage={{ canWrite }}
          onDeleteAll={canWrite ? () => setDeleteAllName(viewPlugin.name) : undefined}
          publicUrl={viewPublicUrl}
          publishHref={viewPublishHref}
        />
      )}

      {/* Sticky bottom bulk actions bar */}
      {canBulk && (
        <BulkActionBar
          count={selectedIds.size}
          busy={bulkLoading}
          onActivate={(isActive) => void handleBulkActivate(isActive)}
          onDelete={() => setShowBulkDelete(true)}
          onClear={clearSelection}
        />
      )}
    </DashboardLayout>
  );
}

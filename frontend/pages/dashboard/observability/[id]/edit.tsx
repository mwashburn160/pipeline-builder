// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { GripVertical, LayoutGrid, List, Plus, Save, X, ArrowUp, ArrowDown } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { useUnsavedChangesWarning } from '@/hooks/useUnsavedChangesWarning';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { LinkButton } from '@/components/ui/LinkButton';
import { Input } from '@/components/ui/Input';
import { AddPanelModal } from '@/components/observability/AddPanelModal';
import { useDashboardDraft } from '@/hooks/internal/useDashboardDraft';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { RetryError } from '@/components/ui/RetryError';
import { EmptyState } from '@/components/ui/EmptyState';
import { api } from '@/lib/api';
import type { DashboardWithPanels, CatalogEntry, DashboardWrite } from '@/types/observability';
import type { LayoutPanelInput } from '@/components/observability/DashboardLayoutGrid';
import { formatError } from '@/lib/constants';
import { useElementWidth } from '@/hooks/useElementWidth';

// Load the grid-layout driver only on this page. `ssr: false` is
// load-bearing: react-grid-layout reads `window` during measurement.
const DashboardLayoutGrid = dynamic(() => import('@/components/observability/DashboardLayoutGrid'), { ssr: false });

/**
 * Dashboard editor.
 *
 * Two modes share the same draft state:
 * - Grid: react-grid-layout drag-resize; coords flow into
 *   `layoutJson` via a position-based key (`p-${index}`) that survives
 *   PUT (which re-assigns panel ids).
 * - List: linear ArrowUp/Down + span dropdown; kept for keyboard /
 *   accessibility users and as the fallback if the grid library fails
 *   to load.
 *
 * The grid module is `next/dynamic`-imported so the ~120 KB react-grid-layout
 * bundle only ships when an editor is open.
 *
 * Save semantics: panels are an atomic full-set replace on PUT. Drafting in
 * local state and shipping the whole set on Save means no "half-saved" view
 * for other readers if the request fails mid-flight.
 */
/** Stable empty catalog until the read lands (keeps AddPanelModal's props steady). */
const EMPTY_CATALOG: CatalogEntry[] = [];

export default function DashboardEditPage() {
  // View on `dashboards:read`; persisting edits is a `dashboards:write`
  // capability gated on `can()` (the backend rejects the PUT otherwise, and
  // `can()` reports false under read-only impersonation so Save disables).
  // Superadmins bypass.
  const { accessDenied, isReady, isAuthenticated, can } = useAuthGuard();
  const canWrite = can('dashboards:write');
  const router = useRouter();
  const toast = useToast();
  const id = typeof router.query.id === 'string' ? router.query.id: '';

  // Title/description/visibility plus the panel list, its React keys and the
  // grid coordinates — one reducer, because move/remove/add each have to change
  // all three panel structures together (see the hook).
  const {
    draft, load, setName, setDescription, setVisibility,
    setPanelField, movePanel, removePanel, addPanel, setLayout, isDirty,
  } = useDashboardDraft();
  const { name, description, visibility, panels, panelKeys, layoutJson } = draft;
  // editor defaults to drag-resize for new sessions, but anyone who
  // prefers the linear list still has it one click away.
  const [editorMode, setEditorMode] = useState<'grid' | 'list'>('grid');
  // Callback-ref measured — see useElementWidth for why a mount-only effect
  // left every dashboard stuck at 960px.
  const [gridContainerRef, gridWidth] = useElementWidth(960);
  const [saving, setSaving] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);

  // Fetch dashboard + catalog in parallel; the draft state below is seeded
  // from the dashboard once it lands.
  const ready = isReady && isAuthenticated && !!id;
  const { data: loaded, loading, error, refetch } = useFetch<{ dashboard: DashboardWithPanels | null; catalog: CatalogEntry[] } | null>(
    async (signal) => {
      if (!ready) return null;
      const [dRes, cRes] = await Promise.all([api.getDashboard(id, signal), api.observabilityCatalog(signal)]);
      return { dashboard: dRes.data?.dashboard ?? null, catalog: cRes.data?.entries ?? [] };
    },
    [ready, id],
  );
  const original = loaded?.dashboard ?? null;
  const catalog = loaded?.catalog ?? EMPTY_CATALOG;

  useEffect(() => {
    if (original) load(original);
  }, [original, load]);

  const dirty = isDirty(original);

  // Warn on Back / reload / tab-close / in-app navigation while there are
  // unsaved edits. `allowNavigation()` is called on Save to bypass the guard
  // for the intentional post-save redirect.
  const allowNavigation = useUnsavedChangesWarning(dirty);

  const onSave = async () => {
    if (!original) return;
    if (!canWrite) { toast.error('Read-only — requires dashboards:write'); return; }
    if (!name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const body: DashboardWrite = {
        name: name.trim(),
        description: description.trim() ? description.trim(): null,
        visibility,
        // layoutJson round-trips through the API as-is, keyed by
        // `p-${position}` so it survives PUT (which re-assigns panel ids).
        layoutJson,
        panels: panels.map((p, i) => ({
          queryKey: p.queryKey,
          vizKind: p.vizKind,
          title: p.title,
          span: p.span,
          groupBy: p.groupBy ?? undefined,
          format: p.format ?? undefined,
          position: i,
        })),
      };
      await api.updateDashboard(original.id, body);
      toast.success('Dashboard saved');
      // Draft is now persisted — let the redirect through without a prompt.
      allowNavigation();
      void router.push(`/dashboard/observability/${original.id}`);
    } catch (err) {
      toast.error(formatError(err));
    } finally {
      setSaving(false);
    }
  };

  if (accessDenied) return <AccessDenied denial={accessDenied} />;
  if (!isReady || !isAuthenticated || !id) return <LoadingPage />;
  if (loading && !loaded) return <LoadingPage />;
  if (error || !original) {
    return (
      <DashboardLayout title="Edit dashboard" subtitle="">
        {error
          ? <RetryError message={formatError(error)} onRetry={refetch} />
          : <EmptyState icon={LayoutGrid} title="Dashboard not found" description="It may have been deleted, or you no longer have access to it." />}
        <Link href="/dashboard/observability" className="mt-4 inline-block text-brand hover:underline text-sm">← Back</Link>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout
      title={`Editing: ${original.name}`}
      subtitle="Drag panels in grid mode to rearrange; resize from any corner. Toggle to list view for keyboard-friendly editing."
      breadcrumbs={[
        { label: 'Observability', href: '/dashboard/observability' },
        { label: original.name, href: `/dashboard/observability/${original.id}` },
        { label: 'Edit' },
      ]}
      actions={
        <div className="flex items-center gap-2">
          <LinkButton
            href={`/dashboard/observability/${original.id}`}
            variant="secondary"
            size="xs"
          >
            Discard
          </LinkButton>
          <Button
            variant="primary"
            size="xs"
            onClick={() => void onSave()}
            disabled={saving || !name.trim() || !canWrite}
            title={canWrite ? undefined : 'Read-only — requires dashboards:write'}
            className="gap-1"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Metadata */}
        <div className="rounded-lg border border-default bg-surface p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Name</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Visibility</label>
            <Select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as typeof visibility)}
            >
              <option value="private">Private (only me)</option>
              <option value="org">Org (anyone in my organization)</option>
              <option value="public">Public (every authenticated user) — sysadmin only</option>
            </Select>
          </div>
        </div>

        {/* Panels — grid or list view; mode-switch keeps the linear
            UI as an option for keyboard / accessibility users. */}
        <div className="rounded-lg border border-default bg-surface">
          <div className="flex items-center justify-between px-4 py-3 border-b border-default">
            <h3 className="text-sm font-semibold">Panels ({panels.length})</h3>
            <div className="flex items-center gap-2">
              <div className="inline-flex border border-default rounded overflow-hidden text-xs">
                <button
                  onClick={() => setEditorMode('grid')}
                  className={`px-2 py-1 inline-flex items-center gap-1 ${editorMode === 'grid' ? 'bg-brand text-white' : 'hover:bg-surface-muted'}`}
                  aria-pressed={editorMode === 'grid'}
                >
                  <LayoutGrid className="w-3.5 h-3.5" /> Grid
                </button>
                <button
                  onClick={() => setEditorMode('list')}
                  className={`px-2 py-1 inline-flex items-center gap-1 ${editorMode === 'list' ? 'bg-brand text-white' : 'hover:bg-surface-muted'}`}
                  aria-pressed={editorMode === 'list'}
                >
                  <List className="w-3.5 h-3.5" /> List
                </button>
              </div>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setShowAddPanel(true)}
                className="gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add panel
              </Button>
            </div>
          </div>
          {panels.length === 0 ? (
            <div className="p-6 text-center text-sm text-fg-muted">
              No panels yet. Click <strong>Add panel</strong> to start.
            </div>
          ) : editorMode === 'grid' ? (
            <div ref={gridContainerRef} className="p-2">
              <DashboardLayoutGrid
                panels={panels.map<LayoutPanelInput>((p, i) => ({ id: `p-${i}`, title: p.title, span: p.span }))}
                layoutJson={layoutJson}
                onChange={setLayout}
                width={gridWidth}
                renderPanel={(_panel, i) => (
                  <div className="h-full flex flex-col gap-1">
                    <div className="flex items-center gap-2 mb-1">
                      {/* `.grid-drag-handle` is the only zone where dragging the
                          panel is allowed — keeps inputs clickable inside. */}
                      {/* Mouse: drag this handle. It is not focusable, so it's
                          hidden from assistive tech — the Move up/down buttons
                          below are the keyboard-reachable equivalent. */}
                      <span className="grid-drag-handle cursor-move text-fg-subtle" aria-hidden="true">
                        <GripVertical className="w-3.5 h-3.5" />
                      </span>
                      <input
                        type="text"
                        value={panels[i].title}
                        onChange={(e) => setPanelField(i, { title: e.target.value })}
                        aria-label={`Panel ${i + 1} title`}
                        className="flex-1 px-2 py-1 text-sm border border-default rounded bg-surface"
                      />
                      <IconButton
                        onClick={() => movePanel(i, -1)}
                        disabled={i === 0}
                        aria-label={`Move ${panels[i].title || `panel ${i + 1}`} earlier`}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </IconButton>
                      <IconButton
                        onClick={() => movePanel(i, 1)}
                        disabled={i === panels.length - 1}
                        aria-label={`Move ${panels[i].title || `panel ${i + 1}`} later`}
                      >
                        <ArrowDown className="w-4 h-4" />
                      </IconButton>
                      <IconButton
                        onClick={() => removePanel(i)}
                        tone="danger"
                        aria-label="Remove panel"
                      >
                        <X className="w-4 h-4" />
                      </IconButton>
                    </div>
                    <div className="text-xs text-fg-muted font-mono truncate">
                      {panels[i].queryKey} · {panels[i].vizKind}
                    </div>
                    <Select
                      value={panels[i].vizKind}
                      onChange={(e) => setPanelField(i, { vizKind: e.target.value })}
                      aria-label={`Panel ${i + 1} visualization type`}
                      className="px-2 py-0.5 text-xs border border-default rounded bg-surface"
                    >
                      <option value="stat">stat</option>
                      <option value="line">line</option>
                      <option value="table">table</option>
                      <option value="stacked-bar">stacked-bar</option>
                    </Select>
                  </div>
                )}
              />
            </div>
          ) : (
            <ul className="divide-y divide-default">
              {panels.map((p, i) => (
                <li key={panelKeys[i] ?? i} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex flex-col gap-0.5">
                    <IconButton
                      onClick={() => movePanel(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="disabled:opacity-30"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </IconButton>
                    <IconButton
                      onClick={() => movePanel(i, 1)}
                      disabled={i === panels.length - 1}
                      aria-label="Move down"
                      className="disabled:opacity-30"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </IconButton>
                  </div>
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={p.title}
                      onChange={(e) => setPanelField(i, { title: e.target.value })}
                      aria-label={`Panel ${i + 1} title`}
                      className="w-full px-2 py-1 text-sm border border-default rounded bg-surface text-fg"
                    />
                    <div className="text-xs text-fg-muted mt-1 font-mono">
                      {p.queryKey} · {p.vizKind} · span={p.span}
                    </div>
                  </div>
                  <Select
                    value={p.vizKind}
                    onChange={(e) => setPanelField(i, { vizKind: e.target.value })}
                    aria-label={`Panel ${i + 1} visualization type`}
                    className="px-2 py-1 text-xs border border-default rounded bg-surface"
                  >
                    <option value="stat">stat</option>
                    <option value="line">line</option>
                    <option value="table">table</option>
                    <option value="stacked-bar">stacked-bar</option>
                  </Select>
                  <Select
                    value={p.span}
                    onChange={(e) => setPanelField(i, { span: parseInt(e.target.value, 10) })}
                    aria-label={`Panel ${i + 1} column span`}
                    className="px-2 py-1 text-xs border border-default rounded bg-surface"
                  >
                    {[3, 4, 6, 8, 9, 12].map(s => <option key={s} value={s}>span {s}</option>)}
                  </Select>
                  <IconButton
                    onClick={() => removePanel(i)}
                    tone="danger"
                    aria-label="Remove panel"
                  >
                    <X className="w-4 h-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {showAddPanel && (
        <AddPanelModal
          catalog={catalog}
          onClose={() => setShowAddPanel(false)}
          onAdd={(entry, title, vizKind, span) => { addPanel(entry, title, vizKind, span); setShowAddPanel(false); }}
        />
      )}
    </DashboardLayout>
  );
}

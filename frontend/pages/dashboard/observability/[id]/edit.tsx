// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { GripVertical, LayoutGrid, List, Plus, Save, X, ArrowUp, ArrowDown } from 'lucide-react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useToast } from '@/components/ui/Toast';
import { LoadingPage } from '@/components/ui/Loading';
import { DashboardLayout } from '@/components/ui/DashboardLayout';
import { Modal } from '@/components/ui/Modal';
import { api, ApiError } from '@/lib/api';
import type { DashboardWithPanels, DashboardPanel, CatalogEntry, DashboardWrite } from '@/types/observability';
import type { LayoutPanelInput, PanelCoords } from '@/components/observability/DashboardLayoutGrid';

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
export default function DashboardEditPage() {
  // Editing a dashboard is a `dashboards:write` capability (superadmins bypass).
  const { isReady, isAuthenticated } = useAuthGuard({ requirePermission: 'dashboards:write' });
  const router = useRouter();
  const toast = useToast();
  const id = typeof router.query.id === 'string' ? router.query.id: '';

  const [original, setOriginal] = useState<DashboardWithPanels | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'org' | 'public'>('private');
  const [panels, setPanels] = useState<Array<Omit<DashboardPanel, 'id' | 'dashboardId'>>>([]);
  const [layoutJson, setLayoutJson] = useState<Record<string, PanelCoords>>({});
  // editor defaults to drag-resize for new sessions, but anyone who
  // prefers the linear list still has it one click away.
  const [editorMode, setEditorMode] = useState<'grid' | 'list'>('grid');
  const [gridWidth, setGridWidth] = useState(960);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddPanel, setShowAddPanel] = useState(false);

  // Measure the grid container so the static-width GridLayout matches the
  // viewport. ResizeObserver gives us width changes on viewport resize +
  // sidebar toggles without polling.
  useEffect(() => {
    if (!gridContainerRef.current) return;
    const el = gridContainerRef.current;
    const measure = () => setGridWidth(Math.max(320, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editorMode]);

  // Fetch dashboard + catalog in parallel.
  useEffect(() => {
    if (!isReady || !isAuthenticated || !id) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const [dRes, cRes] = await Promise.all([api.getDashboard(id), api.observabilityCatalog()]);
        if (cancelled) return;
        const d = dRes.data?.dashboard;
        if (!d) { setError('Dashboard not found'); return; }
        setOriginal(d);
        setName(d.name);
        setDescription(d.description ?? '');
        setVisibility(d.visibility);
        setPanels(d.panels.map(({ id: _id, dashboardId: _did,...rest }) => rest));
        // layoutJson keys are `p-${position}` end-to-end (server keeps
        // whatever map we send). Position-based keys survive PUT — which
        // re-assigns panel ids — without invalidating the saved layout.
        setLayoutJson(d.layoutJson ?? {});
        setCatalog(cRes.data?.entries ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message: (err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isReady, isAuthenticated, id]);

  // List-mode reordering swaps panels AND swaps their layoutJson entries
  // so the grid view stays consistent if the user toggles back. Grid-mode
  // drags update layoutJson directly via `onChange` from DashboardLayoutGrid.
  const movePanel = useCallback((index: number, delta: -1 | 1) => {
    setPanels((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((p, i) => ({...p, position: i }));
    });
    setLayoutJson((prev) => {
      const target = index + delta;
      if (target < 0) return prev;
      const aKey = `p-${index}`;
      const bKey = `p-${target}`;
      const a = prev[aKey];
      const b = prev[bKey];
      const out = {...prev };
      if (a !== undefined) out[bKey] = a; else delete out[bKey];
      if (b !== undefined) out[aKey] = b; else delete out[aKey];
      return out;
    });
  }, []);

  const removePanel = useCallback((index: number) => {
    setPanels(prev => prev.filter((_, i) => i !== index).map((p, i) => ({...p, position: i })));
    setLayoutJson((prev) => {
      // Shift any layoutJson entries past `index` down by one to match the
      // renumbered positions.
      const out: Record<string, PanelCoords> = {};
      for (const [k, v] of Object.entries(prev)) {
        const pos = parseInt(k.replace(/^p-/, ''), 10);
        if (Number.isNaN(pos) || pos === index) continue;
        out[`p-${pos < index ? pos: pos - 1}`] = v;
      }
      return out;
    });
  }, []);

  const addPanel = useCallback((entry: CatalogEntry, title: string, vizKind: string, span: number) => {
    setPanels(prev => [
...prev,
      {
        queryKey: entry.key,
        vizKind,
        title,
        span,
        groupBy: null,
        format: null,
        position: prev.length,
        vars: {},
      },
    ]);
    // New panels have no saved coords — the grid driver computes a default
    // slot on render; no layoutJson update needed at insert time.
    setShowAddPanel(false);
  }, []);

  const onSave = async () => {
    if (!original) return;
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
          vars: p.vars,
        })),
      };
      await api.updateDashboard(original.id, body);
      toast.success('Dashboard saved');
      void router.push(`/dashboard/observability/${original.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message: (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!isReady || !isAuthenticated) return <LoadingPage />;
  if (loading) return <LoadingPage />;
  if (error || !original) {
    return (
      <DashboardLayout title="Edit dashboard" subtitle="">
        <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">
          {error ?? 'Dashboard not found'}
        </div>
        <Link href="/dashboard/observability" className="mt-4 inline-block text-blue-600 hover:underline text-sm">← Back</Link>
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
          <Link
            href={`/dashboard/observability/${original.id}`}
            className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Discard
          </Link>
          <button
            onClick={() => void onSave()}
            disabled={saving || !name.trim()}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Metadata */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Visibility</label>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as typeof visibility)}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              <option value="private">Private (only me)</option>
              <option value="org">Org (anyone in my organization)</option>
              <option value="public">Public (every authenticated user) — sysadmin only</option>
            </select>
          </div>
        </div>

        {/* Panels — grid or list view; mode-switch keeps the linear
            UI as an option for keyboard / accessibility users. */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold">Panels ({panels.length})</h3>
            <div className="flex items-center gap-2">
              <div className="inline-flex border border-gray-300 dark:border-gray-600 rounded overflow-hidden text-xs">
                <button
                  onClick={() => setEditorMode('grid')}
                  className={`px-2 py-1 inline-flex items-center gap-1 ${editorMode === 'grid' ? 'bg-blue-600 text-white' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                  aria-pressed={editorMode === 'grid'}
                >
                  <LayoutGrid className="w-3.5 h-3.5" /> Grid
                </button>
                <button
                  onClick={() => setEditorMode('list')}
                  className={`px-2 py-1 inline-flex items-center gap-1 ${editorMode === 'list' ? 'bg-blue-600 text-white' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                  aria-pressed={editorMode === 'list'}
                >
                  <List className="w-3.5 h-3.5" /> List
                </button>
              </div>
              <button
                onClick={() => setShowAddPanel(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Plus className="w-3.5 h-3.5" /> Add panel
              </button>
            </div>
          </div>
          {panels.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
              No panels yet. Click <strong>Add panel</strong> to start.
            </div>
          ) : editorMode === 'grid' ? (
            <div ref={gridContainerRef} className="p-2">
              <DashboardLayoutGrid
                panels={panels.map<LayoutPanelInput>((p, i) => ({ id: `p-${i}`, title: p.title, span: p.span }))}
                layoutJson={layoutJson}
                onChange={setLayoutJson}
                width={gridWidth}
                renderPanel={(_panel, i) => (
                  <div className="h-full flex flex-col gap-1">
                    <div className="flex items-center gap-2 mb-1">
                      {/* `.grid-drag-handle` is the only zone where dragging the
                          panel is allowed — keeps inputs clickable inside. */}
                      <span className="grid-drag-handle cursor-move text-gray-400" aria-label="Drag panel">
                        <GripVertical className="w-3.5 h-3.5" />
                      </span>
                      <input
                        type="text"
                        value={panels[i].title}
                        onChange={(e) => setPanels(prev => prev.map((q, j) => j === i ? { ...q, title: e.target.value } : q))}
                        className="flex-1 px-2 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800"
                      />
                      <button
                        onClick={() => removePanel(i)}
                        aria-label="Remove panel"
                        className="text-red-500 hover:text-red-700"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                      {panels[i].queryKey} · {panels[i].vizKind}
                    </div>
                    <select
                      value={panels[i].vizKind}
                      onChange={(e) => setPanels(prev => prev.map((q, j) => j === i ? { ...q, vizKind: e.target.value } : q))}
                      className="px-2 py-0.5 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800"
                    >
                      <option value="stat">stat</option>
                      <option value="line">line</option>
                      <option value="table">table</option>
                      <option value="stacked-bar">stacked-bar</option>
                    </select>
                  </div>
                )}
              />
            </div>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {panels.map((p, i) => (
                <li key={i} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => movePanel(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => movePanel(i, 1)}
                      disabled={i === panels.length - 1}
                      aria-label="Move down"
                      className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={p.title}
                      onChange={(e) => setPanels(prev => prev.map((q, j) => j === i ? {...q, title: e.target.value }: q))}
                      className="w-full px-2 py-1 text-sm border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                    />
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono">
                      {p.queryKey} · {p.vizKind} · span={p.span}
                    </div>
                  </div>
                  <select
                    value={p.vizKind}
                    onChange={(e) => setPanels(prev => prev.map((q, j) => j === i ? {...q, vizKind: e.target.value }: q))}
                    className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800"
                  >
                    <option value="stat">stat</option>
                    <option value="line">line</option>
                    <option value="table">table</option>
                    <option value="stacked-bar">stacked-bar</option>
                  </select>
                  <select
                    value={p.span}
                    onChange={(e) => setPanels(prev => prev.map((q, j) => j === i ? {...q, span: parseInt(e.target.value, 10) }: q))}
                    className="px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800"
                  >
                    {[3, 4, 6, 8, 9, 12].map(s => <option key={s} value={s}>span {s}</option>)}
                  </select>
                  <button
                    onClick={() => removePanel(i)}
                    aria-label="Remove panel"
                    className="text-red-500 hover:text-red-700"
                  >
                    <X className="w-4 h-4" />
                  </button>
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
          onAdd={addPanel}
        />
      )}
    </DashboardLayout>
  );
}

/** Modal to pick a catalog query + viz + title for a new panel. */
function AddPanelModal(props: {
  catalog: CatalogEntry[];
  onClose: () => void;
  onAdd: (entry: CatalogEntry, title: string, vizKind: string, span: number) => void;
}) {
  const { catalog, onClose, onAdd } = props;
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [title, setTitle] = useState('');
  const [vizKind, setVizKind] = useState('line');
  const [span, setSpan] = useState<number>(6);

  const filtered = catalog.filter(c => c.key.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal title="Add panel" onClose={onClose} maxWidth="max-w-lg" tall>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Filter</label>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Type to filter catalog keys…"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Catalog query ({filtered.length})</label>
          <div className="max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded">
            {filtered.map(entry => (
              <button
                key={entry.key}
                onClick={() => { setSelected(entry); if (!title) setTitle(entry.key.replace(/_/g, ' ')); }}
                className={`block w-full text-left px-3 py-1.5 text-xs font-mono border-b border-gray-100 dark:border-gray-800 last:border-b-0 ${selected?.key === entry.key ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-900 dark:text-blue-200' : 'hover:bg-gray-50 dark:hover:bg-gray-800'}`}
              >
                <div>{entry.key}</div>
                <div className="text-[10px] text-gray-500">{entry.source}</div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="p-3 text-xs text-gray-500 dark:text-gray-400">No matches.</div>
            )}
          </div>
        </div>
        {selected && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Viz</label>
                <select
                  value={vizKind}
                  onChange={(e) => setVizKind(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
                >
                  <option value="stat">stat</option>
                  <option value="line">line</option>
                  <option value="table">table</option>
                  <option value="stacked-bar">stacked-bar</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Span</label>
                <select
                  value={span}
                  onChange={(e) => setSpan(parseInt(e.target.value, 10))}
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
                >
                  {[3, 4, 6, 8, 9, 12].map(s => <option key={s} value={s}>span {s}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => onAdd(selected, title.trim() || selected.key, vizKind, span)}
                disabled={!title.trim()}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded disabled:opacity-50"
              >
                Add panel
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

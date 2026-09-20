// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useReducer } from 'react';
import type { CatalogEntry, DashboardPanel, DashboardWithPanels } from '@/types/observability';
import type { PanelCoords } from '@/components/observability/DashboardLayoutGrid';

/** A panel as the editor drafts it — server-assigned ids are not part of the draft. */
export type DraftPanel = Omit<DashboardPanel, 'id' | 'dashboardId'>;

export interface DashboardDraft {
  name: string;
  description: string;
  visibility: 'private' | 'org' | 'public';
  panels: DraftPanel[];
  /**
   * Stable React keys kept lockstep with `panels`. Index keys break the
   * controlled inputs when rows reorder/remove (typing in one row jumps to
   * another) — the same lockstep-id pattern EnvEditor/StepEditor use.
   */
  panelKeys: string[];
  /**
   * Grid coordinates keyed `p-${position}` end-to-end (the server keeps
   * whatever map we send). Position-based keys survive PUT — which re-assigns
   * panel ids — without invalidating the saved layout.
   */
  layoutJson: Record<string, PanelCoords>;
  /** Monotonic source for `panelKeys`. */
  keySeq: number;
}

type Action =
  | { type: 'load'; dashboard: DashboardWithPanels }
  | { type: 'setField'; field: 'name' | 'description'; value: string }
  | { type: 'setVisibility'; value: DashboardDraft['visibility'] }
  | { type: 'setPanelField'; index: number; patch: Partial<DraftPanel> }
  | { type: 'movePanel'; index: number; delta: -1 | 1 }
  | { type: 'removePanel'; index: number }
  | { type: 'addPanel'; entry: CatalogEntry; title: string; vizKind: string; span: number }
  | { type: 'setLayout'; layoutJson: Record<string, PanelCoords> };

const EMPTY: DashboardDraft = {
  name: '', description: '', visibility: 'private',
  panels: [], panelKeys: [], layoutJson: {}, keySeq: 0,
};

function reduce(state: DashboardDraft, action: Action): DashboardDraft {
  switch (action.type) {
    case 'load': {
      const d = action.dashboard;
      return {
        name: d.name,
        description: d.description ?? '',
        visibility: d.visibility,
        panels: d.panels.map(({ id: _id, dashboardId: _did, ...rest }) => rest),
        panelKeys: d.panels.map((_, i) => `panel-${state.keySeq + i}`),
        layoutJson: d.layoutJson ?? {},
        keySeq: state.keySeq + d.panels.length,
      };
    }
    case 'setField':
      return { ...state, [action.field]: action.value };
    case 'setVisibility':
      return { ...state, visibility: action.value };
    case 'setPanelField':
      return {
        ...state,
        panels: state.panels.map((p, i) => (i === action.index ? { ...p, ...action.patch } : p)),
      };
    case 'movePanel': {
      const { index, delta } = action;
      const target = index + delta;
      if (target < 0 || target >= state.panels.length) return state;

      // Reordering swaps the panel, its React key AND its layoutJson entry, so
      // the grid view stays consistent if the user toggles back to it. Doing all
      // three in one reducer case is the point: as three separate `setX(prev =>
      // …)` calls each had to re-derive the bounds check for itself.
      const panels = [...state.panels];
      [panels[index], panels[target]] = [panels[target], panels[index]];

      const panelKeys = [...state.panelKeys];
      [panelKeys[index], panelKeys[target]] = [panelKeys[target], panelKeys[index]];

      const aKey = `p-${index}`;
      const bKey = `p-${target}`;
      const a = state.layoutJson[aKey];
      const b = state.layoutJson[bKey];
      const layoutJson = { ...state.layoutJson };
      if (a !== undefined) layoutJson[bKey] = a; else delete layoutJson[bKey];
      if (b !== undefined) layoutJson[aKey] = b; else delete layoutJson[aKey];

      return { ...state, panels: panels.map((p, i) => ({ ...p, position: i })), panelKeys, layoutJson };
    }
    case 'removePanel': {
      const { index } = action;
      // Shift any layoutJson entries past `index` down by one to match the
      // renumbered positions.
      const layoutJson: Record<string, PanelCoords> = {};
      for (const [k, v] of Object.entries(state.layoutJson)) {
        const pos = parseInt(k.replace(/^p-/, ''), 10);
        if (Number.isNaN(pos) || pos === index) continue;
        layoutJson[`p-${pos < index ? pos : pos - 1}`] = v;
      }
      return {
        ...state,
        panels: state.panels.filter((_, i) => i !== index).map((p, i) => ({ ...p, position: i })),
        panelKeys: state.panelKeys.filter((_, i) => i !== index),
        layoutJson,
      };
    }
    case 'addPanel':
      // New panels have no saved coords — the grid driver computes a default
      // slot on render, so no layoutJson update is needed at insert time.
      return {
        ...state,
        panels: [...state.panels, {
          queryKey: action.entry.key,
          vizKind: action.vizKind,
          title: action.title,
          span: action.span,
          groupBy: null,
          format: null,
          position: state.panels.length,
        }],
        panelKeys: [...state.panelKeys, `panel-${state.keySeq}`],
        keySeq: state.keySeq + 1,
      };
    case 'setLayout':
      return { ...state, layoutJson: action.layoutJson };
  }
}

/**
 * The dashboard editor's draft: title/description/visibility plus the panel
 * list, its React keys and the grid coordinates.
 *
 * A reducer rather than six `useState`s because the three panel operations
 * (move, remove, add) each have to change `panels`, `panelKeys` and
 * `layoutJson` together and consistently — as separate setters, every one of
 * them re-derived the same index arithmetic in its own updater.
 */
export function useDashboardDraft() {
  const [draft, dispatch] = useReducer(reduce, EMPTY);

  const actions = useMemo(() => ({
    load: (dashboard: DashboardWithPanels) => dispatch({ type: 'load', dashboard }),
    setName: (value: string) => dispatch({ type: 'setField', field: 'name', value }),
    setDescription: (value: string) => dispatch({ type: 'setField', field: 'description', value }),
    setVisibility: (value: DashboardDraft['visibility']) => dispatch({ type: 'setVisibility', value }),
    setPanelField: (index: number, patch: Partial<DraftPanel>) => dispatch({ type: 'setPanelField', index, patch }),
    movePanel: (index: number, delta: -1 | 1) => dispatch({ type: 'movePanel', index, delta }),
    removePanel: (index: number) => dispatch({ type: 'removePanel', index }),
    addPanel: (entry: CatalogEntry, title: string, vizKind: string, span: number) =>
      dispatch({ type: 'addPanel', entry, title, vizKind, span }),
    setLayout: (layoutJson: Record<string, PanelCoords>) => dispatch({ type: 'setLayout', layoutJson }),
  }), []);

  /**
   * Draft differs from the loaded doc? Compared field-by-field (panels /
   * layoutJson serialized) so an accidental Back / tab close / sidebar click can
   * warn before discarding edits. Stays false until the doc has loaded.
   */
  const isDirty = useCallback((original: DashboardWithPanels | null) => {
    if (!original) return false;
    if (draft.name !== original.name) return true;
    if (draft.description !== (original.description ?? '')) return true;
    if (draft.visibility !== original.visibility) return true;
    const originalPanels = original.panels.map(({ id: _id, dashboardId: _did, ...rest }) => rest);
    if (JSON.stringify(draft.panels) !== JSON.stringify(originalPanels)) return true;
    if (JSON.stringify(draft.layoutJson) !== JSON.stringify(original.layoutJson ?? {})) return true;
    return false;
  }, [draft]);

  return { draft, ...actions, isDirty };
}

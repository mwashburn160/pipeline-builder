// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useDashboardDraft` replaced six `useState`s in the dashboard editor. The
 * reason it is a reducer is that move / remove / add each have to change three
 * structures TOGETHER — the panel list, its React keys, and the `p-${position}`
 * grid coordinates — so these tests pin that joint consistency.
 */

import { describe, it, expect } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useDashboardDraft } from '../src/hooks/internal/useDashboardDraft';
import type { DashboardWithPanels } from '../src/types/observability';

const panel = (i: number) => ({
  id: `srv-${i}`, dashboardId: 'd1', queryKey: `q${i}`, vizKind: 'line',
  title: `Panel ${i}`, span: 6, groupBy: null, format: null, position: i,
});

const DOC = {
  id: 'd1', name: 'Ops', description: 'desc', visibility: 'org',
  panels: [panel(0), panel(1), panel(2)],
  layoutJson: { 'p-0': { x: 0, y: 0, w: 6, h: 4 }, 'p-2': { x: 6, y: 0, w: 6, h: 4 } },
} as unknown as DashboardWithPanels;

const entry = { key: 'new_query', source: 'loki' } as never;

describe('useDashboardDraft', () => {
  it('seeds from the loaded doc and drops the server-assigned ids', () => {
    const { result } = renderHook(() => useDashboardDraft());
    act(() => result.current.load(DOC));
    expect(result.current.draft.name).toBe('Ops');
    expect(result.current.draft.description).toBe('desc');
    expect(result.current.draft.panels).toHaveLength(3);
    expect(result.current.draft.panels[0]).not.toHaveProperty('id');
    expect(result.current.draft.panels[0]).not.toHaveProperty('dashboardId');
    // One stable key per panel, all distinct.
    expect(new Set(result.current.draft.panelKeys).size).toBe(3);
  });

  it('a freshly loaded draft is not dirty; an edit makes it dirty', () => {
    const { result } = renderHook(() => useDashboardDraft());
    act(() => result.current.load(DOC));
    expect(result.current.isDirty(DOC)).toBe(false);
    act(() => result.current.setName('Ops 2'));
    expect(result.current.isDirty(DOC)).toBe(true);
  });

  it('is never dirty before the doc has loaded', () => {
    const { result } = renderHook(() => useDashboardDraft());
    expect(result.current.isDirty(null)).toBe(false);
  });

  it('move swaps the panel, its key AND its layout entry, renumbering positions', () => {
    const { result } = renderHook(() => useDashboardDraft());
    act(() => result.current.load(DOC));
    const keys = [...result.current.draft.panelKeys];

    act(() => result.current.movePanel(0, 1));

    expect(result.current.draft.panels.map((p) => p.queryKey)).toEqual(['q1', 'q0', 'q2']);
    expect(result.current.draft.panels.map((p) => p.position)).toEqual([0, 1, 2]);
    expect(result.current.draft.panelKeys).toEqual([keys[1], keys[0], keys[2]]);
    // `p-0` held coords and `p-1` did not, so the pair swaps: p-1 gains them, p-0 loses them.
    expect(result.current.draft.layoutJson['p-1']).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(result.current.draft.layoutJson['p-0']).toBeUndefined();
  });

  it('move past either end is a no-op', () => {
    const { result } = renderHook(() => useDashboardDraft());
    act(() => result.current.load(DOC));
    const before = result.current.draft;
    act(() => result.current.movePanel(0, -1));
    act(() => result.current.movePanel(2, 1));
    expect(result.current.draft).toBe(before);
  });

  it('remove renumbers positions and shifts the layout entries down past the hole', () => {
    const { result } = renderHook(() => useDashboardDraft());
    act(() => result.current.load(DOC));

    act(() => result.current.removePanel(1));

    expect(result.current.draft.panels.map((p) => p.queryKey)).toEqual(['q0', 'q2']);
    expect(result.current.draft.panels.map((p) => p.position)).toEqual([0, 1]);
    expect(result.current.draft.panelKeys).toHaveLength(2);
    // p-0 stays; the old p-2 becomes p-1.
    expect(Object.keys(result.current.draft.layoutJson).sort()).toEqual(['p-0', 'p-1']);
  });

  it('add appends a panel with a fresh key and no layout entry', () => {
    const { result } = renderHook(() => useDashboardDraft());
    act(() => result.current.load(DOC));
    const layoutBefore = result.current.draft.layoutJson;

    act(() => result.current.addPanel(entry, 'New one', 'stat', 4));

    const added = result.current.draft.panels[3];
    expect(added).toMatchObject({ queryKey: 'new_query', title: 'New one', vizKind: 'stat', span: 4, position: 3 });
    expect(new Set(result.current.draft.panelKeys).size).toBe(4);
    expect(result.current.draft.layoutJson).toBe(layoutBefore);
  });

  it('patches one panel field without touching its siblings', () => {
    const { result } = renderHook(() => useDashboardDraft());
    act(() => result.current.load(DOC));
    act(() => result.current.setPanelField(1, { title: 'Renamed' }));
    expect(result.current.draft.panels.map((p) => p.title)).toEqual(['Panel 0', 'Renamed', 'Panel 2']);
  });
});

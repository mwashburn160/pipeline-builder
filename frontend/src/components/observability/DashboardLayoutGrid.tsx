// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  react-grid-layout driver for the dashboard editor.
 *
 * Lives in its own module so the dashboard editor page can pull it in via
 * `next/dynamic` with `ssr: false`. That keeps react-grid-layout (~120 KB
 * + react-resizable + react-draggable transitive deps) out of every other
 * route's bundle.
 *
 * Mapping between `layoutJson` and react-grid-layout's `Layout[]` * - layoutJson is keyed by panel id: `{ [panelId]: { x, y, w, h, minW?, minH? } }`
 * - the grid library wants an array of `{ i, x, y, w, h, minW?, minH? }`
 * - panels missing from layoutJson get a default position derived from
 * `panel.position` so legacy dashboards (created before drag-resize was
 * available) still render in a sane order.
 */

import { useMemo } from 'react';
import GridLayout from 'react-grid-layout';
import type { Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

/** Per-panel coordinates as stored in the `Dashboard.layoutJson` field. */
export interface PanelCoords {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

/** Minimum info we need to lay out a panel  title + an id-equivalent key. */
export interface LayoutPanelInput {
  /** Stable id for the panel within the dashboard. Editor uses `position`
   * for unsaved panels, but the key just has to be unique within the set. */
  id: string;
  title: string;
  /** Default span (3/4/6/8/9/12) when no layoutJson entry exists yet. */
  span: number;
}

/** Width of the layout grid in columns. Matches the existing static
 * dashboard's 12-col Tailwind grid so `span` semantics carry over. */
export const GRID_COLS = 12;
/** Default row height in px. Two of these fit a typical stat panel. */
const ROW_HEIGHT = 80;

/** Derive a default position for a panel that has no layoutJson entry yet.
 * Packs left-to-right by `span` so the order matches what the static page
 * would render. New panels appended via the editor land at the bottom. */
function defaultCoords(panel: LayoutPanelInput, prior: PanelCoords[]): PanelCoords {
  const span = Math.min(GRID_COLS, Math.max(1, panel.span));
  // Walk priors to find the next free spot of width `span` on the current row.
  let row = 0;
  let xCursor = 0;
  for (const p of prior) {
    if (p.y > row) { row = p.y; xCursor = 0; }
    if (p.y === row) xCursor = Math.max(xCursor, p.x + p.w);
  }
  if (xCursor + span > GRID_COLS) {
    row = Math.max(row,...prior.map(p => p.y + p.h)) || 0;
    xCursor = 0;
  }
  return { x: xCursor, y: row, w: span, h: 2 };
}

/**
 * Hydrate the editor's view of layoutJson into a complete `Layout[]` the grid
 * library can consume, filling in defaults for any panel without a saved entry.
 */
export function buildLayout(  panels: LayoutPanelInput[],
  layoutJson: Record<string, PanelCoords>,
): Layout[] {
  const accumulated: PanelCoords[] = [];
  return panels.map((panel) => {
    const saved = layoutJson[panel.id];
    const coords = saved ?? defaultCoords(panel, accumulated);
    accumulated.push(coords);
    return {
      i: panel.id,
      x: coords.x,
      y: coords.y,
      w: coords.w,
      h: coords.h,
      minW: coords.minW ?? 2,
      minH: coords.minH ?? 1,
    };
  });
}

/** Convert react-grid-layout's `Layout[]` back into the `layoutJson` map shape
 * the API expects. Drops any incoming `minW/minH` so we don't pin defaults
 * the user didn't explicitly set. */
export function layoutToJson(layout: Layout[]): Record<string, PanelCoords> {
  const out: Record<string, PanelCoords> = {};
  for (const l of layout) {
    out[l.i] = { x: l.x, y: l.y, w: l.w, h: l.h };
  }
  return out;
}

/**
 * Editor- or read-only grid: renders each panel using the parent-supplied
 * render slot. In editor mode the `onChange` callback receives the updated
 * `layoutJson` whenever the user drags or resizes; in read-only mode the
 * `onChange` is never called (drag + resize are disabled).
 */
export default function DashboardLayoutGrid(props: {
  panels: LayoutPanelInput[];
  layoutJson: Record<string, PanelCoords>;
  /** Called on every drag / resize when `readOnly` is false. Required only
   * in editor mode  the read-only page passes a no-op or omits it. */
  onChange?: (next: Record<string, PanelCoords>) => void;
  /** Per-panel render slot  the parent supplies the actual content
   * (control row in the editor, panel viz on the read page). */
  renderPanel: (panel: LayoutPanelInput, index: number) => React.ReactNode;
  /** Container width in px, supplied by the parent. We don't use
   * `WidthProvider` to avoid a ResizeObserver dependency in tests. */
  width: number;
  /** Disable drag + resize. Read-only mode also drops the
   * `draggableHandle` requirement so panels stay statically positioned. */
  readOnly?: boolean;
}) {
  const { panels, layoutJson, onChange, renderPanel, width, readOnly = false } = props;

  const layout = useMemo(() => buildLayout(panels, layoutJson), [panels, layoutJson]);

  return (    <GridLayout
      className="layout"
      layout={layout}
      cols={GRID_COLS}
      rowHeight={ROW_HEIGHT}
      width={width}
      margin={[8, 8]}
      compactType="vertical"
      isDraggable={!readOnly}
      isResizable={!readOnly}
      draggableHandle={readOnly ? undefined: '.grid-drag-handle'}
      onLayoutChange={(next) => { if (!readOnly && onChange) onChange(layoutToJson(next)); }}
    >
      {panels.map((panel, i) => (        <div
          key={panel.id}
          className={readOnly
            ? 'overflow-hidden'
: 'rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 overflow-hidden'}
        >
          {renderPanel(panel, i)}
        </div>
      ))}
    </GridLayout>
  );
}

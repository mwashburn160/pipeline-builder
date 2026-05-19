// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry Activity dashboard — visibility into the in-cluster Docker
 * registry: copy / delete / promote rates over time.
 */

export type PanelKind = 'stat' | 'line';

export interface RegistryActivityPanel {
  id: string;
  kind: PanelKind;
  title: string;
  queryKey: string;
  span: 3 | 4 | 6 | 8 | 9 | 12;
  groupBy?: string;
  format?: 'percent' | 'seconds';
}

export const REGISTRY_ACTIVITY_DASHBOARD: { id: string; title: string; panels: RegistryActivityPanel[] } = {
  id: 'registry-activity',
  title: 'Registry Activity',
  panels: [
    { id: 'copies-24h', kind: 'stat', title: 'Copies (24h)', queryKey: 'registry_copies_24h', span: 4 },
    { id: 'deletes-24h', kind: 'stat', title: 'Deletes (24h)', queryKey: 'registry_deletes_24h', span: 4 },
    { id: 'promos-24h', kind: 'stat', title: 'Promotions to system (24h)', queryKey: 'registry_promotions_24h', span: 4 },

    { id: 'copies-trend', kind: 'line', title: 'Copies per minute', queryKey: 'registry_copies_per_min', span: 6 },
    { id: 'deletes-trend', kind: 'line', title: 'Deletes per minute', queryKey: 'registry_deletes_per_min', span: 6 },
    { id: 'promos-trend', kind: 'line', title: 'Promotions per hour', queryKey: 'registry_promotions_per_hour', span: 12 },
  ],
};

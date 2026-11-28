// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugins page's non-blocking side reads: per-plugin usage counts, the
 * plugins that shadow a listing or a parent org's plugin, and the org's own
 * publisher listings by `name@version`.
 */

import { useMemo } from 'react';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { ListingView } from '@/types/ecosystem';

export function usePluginLookups(isAuthenticated: boolean, canPublish: boolean) {
  // Plugin usage counts (how many of the org's pipelines reference each plugin).
  // Non-blocking — on failure the "Used by" badge just doesn't render.
  const { data: usageData } = useFetch(async () => {
    if (!isAuthenticated) return {};
    try {
      return (await api.getPluginUsage()).data?.counts ?? {};
    } catch {
      return {};
    }
  }, [isAuthenticated]);
  const pluginUsage = useMemo(() => usageData ?? {}, [usageData]);

  // Plugins whose names override something this org would otherwise resolve:
  // a catalog LISTING, or — for a team — the PARENT ORG's plugin of the same
  // name. Both come from one call. Non-blocking too.
  const { data: shadowingData } = useFetch(async () => {
    if (!isAuthenticated) return null;
    try {
      return (await api.getPluginShadowing()).data ?? null;
    } catch {
      return null;
    }
  }, [isAuthenticated]);
  const shadowedById = useMemo(() => {
    const m = new Map<string, { kind: 'listing' | 'parent-org'; publisherHandle: string; name: string }>();
    for (const s of shadowingData?.shadowing ?? []) {
      for (const id of s.pluginIds) m.set(id, { kind: 'listing', ...s.listing });
    }
    // The parent-org shadow has no listing and no publisher. It was reported by
    // the API and rendered nowhere, so a team silently overriding its parent's
    // plugin — the likeliest collision once an org has teams — was invisible.
    // `pluginIds` are the TEAM's (the shadowing side); `parentPluginIds` are
    // the ones being hidden and belong to another org, so they are not keyed.
    for (const s of shadowingData?.parentOrg ?? []) {
      for (const id of s.pluginIds) m.set(id, { kind: 'parent-org', publisherHandle: '', name: s.name });
    }
    return m;
  }, [shadowingData]);

  // The org's own publisher listings, each with its versions: whether a version
  // is already in the ecosystem (no "Publish to ecosystem…"; "View public page"
  // instead). Read once per page, only by someone who may publish. Null while
  // unknown or on failure — then the publish link shows and the server refuses
  // a duplicate on its own.
  const { data: ownListings } = useFetch(async () => {
    if (!isAuthenticated || !canPublish) return null;
    try {
      return (await api.listPublisherListings()).data?.listings ?? null;
    } catch {
      return null;
    }
  }, [isAuthenticated, canPublish]);
  /** `name@version` → the own listing that holds that version. */
  const listedVersions = useMemo(() => {
    const m = new Map<string, ListingView>();
    for (const l of ownListings ?? []) {
      for (const v of l.versions ?? []) m.set(`${l.name}@${v.version}`, l);
    }
    return m;
  }, [ownListings]);

  return { pluginUsage, shadowedById, listedVersions };
}

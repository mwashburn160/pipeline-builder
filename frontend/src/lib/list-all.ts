// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whole-list reads for PICKERS.
 *
 * A picker that reads one fixed-size page and treats it as the complete list
 * silently drops everything past the cap: members beyond row 200 could not be
 * picked as a support contact, a report owner or a notification recipient, and
 * active plugins beyond row 500 were missing from the pipeline editor — with
 * nothing on screen saying the list had been cut. These drain the paged route
 * instead, following `hasMore` (so a lower server-side `MAX_PAGE_LIMIT` only
 * costs more pages), and throw when a page fails, so a partial list is never
 * mistaken for the whole one.
 */

import api from './api';
import type { OrganizationMember, Plugin } from '@/types';

/** Rows asked for per page — the server's default `MAX_PAGE_LIMIT`. */
export const LIST_ALL_PAGE_SIZE = 1000;
/** Runaway guard — 50 × 1000 rows is far past any real org. */
const LIST_ALL_MAX_PAGES = 50;

/** EVERY member of `orgId` matching `params`, page by page. */
export async function listAllOrgMembers(
  orgId: string,
  params: { status?: 'active' | 'inactive' } = {},
  signal?: AbortSignal,
): Promise<OrganizationMember[]> {
  const out: OrganizationMember[] = [];
  for (let page = 0; page < LIST_ALL_MAX_PAGES; page++) {
    const res = await api.getOrganizationMembers(orgId, { ...params, limit: LIST_ALL_PAGE_SIZE, offset: out.length }, { signal });
    if (!res.data) throw new Error(res.message || 'Failed to list members');
    const rows = res.data.members ?? [];
    out.push(...rows);
    if (!res.data.pagination?.hasMore || rows.length === 0) break;
  }
  return out;
}

/** EVERY plugin matching `params`: the keyset cursor when the server hands one
 *  back, the offset otherwise. */
export async function listAllPlugins(params: Record<string, string> = {}, signal?: AbortSignal): Promise<Plugin[]> {
  const out: Plugin[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_ALL_MAX_PAGES; page++) {
    const q: Record<string, string> = { ...params, limit: String(LIST_ALL_PAGE_SIZE) };
    if (cursor) q.cursor = cursor;
    else if (out.length > 0) q.offset = String(out.length);
    const res = await api.listPlugins(q, { signal });
    if (!res.data) throw new Error(res.message || 'Failed to list plugins');
    const rows = res.data.plugins ?? [];
    out.push(...rows);
    if (!res.data.pagination?.hasMore || rows.length === 0) break;
    cursor = res.data.pagination.nextCursor;
  }
  return out;
}

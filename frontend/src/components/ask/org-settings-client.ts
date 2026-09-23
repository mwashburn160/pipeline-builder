// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The only thing the browser adds to the shared org-settings allowlist: which
 * typed API client serves each SURFACE.
 *
 * Everything else — which settings are proposable, what values they accept,
 * which permission each route wants, and what the request body's field is
 * called — comes from `@pipeline-builder/api-core/ask-proposals`, the one table
 * the tool schema, this confirm handler and both sides' tests share. Nothing
 * here re-states a field name or a permission: `spec.field` maps a proposal key
 * onto the body, `spec.permission` gates it, and this module only knows how to
 * reach the three records those specs name.
 *
 * The three surfaces are three different services with no transaction between
 * them, so a proposal spanning them applies per surface and reports partial
 * failure honestly — a half-applied change must never render as success.
 */

import {
  ORG_SETTING_PROPOSAL_ALLOWLIST,
  type OrgSettingKey,
  type OrgSettingPatch,
  type OrgSettingRequest,
  type OrgSettingSurface,
  type OrgSettingValue,
} from '@pipeline-builder/api-core/ask-proposals';
import api from '@/lib/api';
import type { ProposedByOptions } from '@/lib/api/util';

/**
 * Every write this module makes is an agent draft the user reviewed and
 * clicked Apply on, so the marker is constant rather than a parameter — there
 * is no path through here that is not a proposal commit.
 */
const PROPOSED_BY_AGENT: ProposedByOptions = { proposedByAgent: true };

interface SurfaceClient {
  /** Human name, for a partial-failure message. */
  label: string;
  /** The live record, keyed by the API's own field names (`spec.field`). */
  read: () => Promise<Record<string, unknown>>;
  /**
   * Write a partial body, keyed by the API's own field names.
   *
   * `opts` carries the one thing that is not part of the body: the provenance
   * marker (rule 6), which every write from here sets because every write from
   * here IS an agent draft the user applied. It rides the `X-PB-Proposed-By`
   * header, so it can never be mistaken for one of the reviewed fields.
   */
  apply: (body: Record<string, unknown>, opts: ProposedByOptions) => Promise<void>;
}

/** Exhaustive by construction: a new surface in the shared table is a type error here. */
const SURFACE_CLIENTS: Record<OrgSettingSurface, SurfaceClient> = {
  reporting: {
    label: 'incident reporting',
    read: async () => ({ ...(await api.getIncidentSettings()) }),
    apply: async (body, opts) => { await api.putReportingSettings(body as Parameters<typeof api.putReportingSettings>[0], opts); },
  },
  complianceNotifications: {
    label: 'compliance notifications',
    read: async () => ({ ...(await api.getComplianceNotificationPreference()).data?.preference }),
    apply: async (body, opts) => { await api.updateComplianceNotificationPreference(body as Parameters<typeof api.updateComplianceNotificationPreference>[0], opts); },
  },
  pluginSecurityNotifications: {
    label: 'plugin security notifications',
    read: async () => ({ ...(await api.getPluginSecurityNotifications()).data?.preferences }),
    apply: async (body, opts) => { await api.updatePluginSecurityNotifications(body as Parameters<typeof api.updatePluginSecurityNotifications>[0], opts); },
  },
};

/** The surface a planned request belongs to, and how to reach it. */
export function surfaceClient(surface: OrgSettingSurface): SurfaceClient | undefined {
  return SURFACE_CLIENTS[surface];
}

/**
 * The org's CURRENT values for the given proposal keys, keyed by proposal key.
 *
 * Only the surfaces the keys touch are read — a proposal about one boolean does
 * not pull three records — and only the allowlisted fields are lifted out of
 * each record, so nothing else (a recipient list, a webhook URL, a secret flag)
 * enters the panel's state at all.
 */
export async function readOrgSettings(keys: readonly OrgSettingKey[]): Promise<OrgSettingPatch> {
  const wanted = new Set<string>(keys);
  const specs = ORG_SETTING_PROPOSAL_ALLOWLIST.filter((s) => wanted.has(s.key));
  const surfaces = [...new Set(specs.map((s) => s.surface))];
  const records = await Promise.all(surfaces.map(async (surface) => [surface, await SURFACE_CLIENTS[surface].read()] as const));
  const bySurface = new Map(records);

  const out: OrgSettingPatch = {};
  for (const spec of specs) {
    const value = bySurface.get(spec.surface)?.[spec.field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[spec.key] = value as OrgSettingValue;
  }
  return out;
}

/** A surface whose write did not land, and why. */
export interface OrgSettingFailure {
  surface: OrgSettingSurface;
  label: string;
  message: string;
}

/**
 * Apply the planned requests, one per surface.
 *
 * Applied surfaces are reported alongside failed ones rather than unwound:
 * there is no transaction across three services, and silently "rolling back" a
 * setting by writing the old value is another unreviewed write. The caller says
 * plainly which ones landed.
 */
export async function applyOrgSettingRequests(
  requests: readonly OrgSettingRequest[],
): Promise<{ applied: OrgSettingSurface[]; failed: OrgSettingFailure[] }> {
  const applied: OrgSettingSurface[] = [];
  const failed: OrgSettingFailure[] = [];
  for (const req of requests) {
    const client = SURFACE_CLIENTS[req.surface];
    if (!client) {
      failed.push({ surface: req.surface, label: req.surface, message: 'this app cannot reach that settings route' });
      continue;
    }
    try {
      await client.apply(req.body, PROPOSED_BY_AGENT);
      applied.push(req.surface);
    } catch (e) {
      failed.push({ surface: req.surface, label: client.label, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { applied, failed };
}

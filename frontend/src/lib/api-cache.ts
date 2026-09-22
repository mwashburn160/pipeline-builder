// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cached reads for the endpoints this app fans out on hardest.
 *
 * Six endpoints account for most of the duplicate traffic: `listPipelines` is
 * called from nine places, `listOrganizations` / `getOrganizationMembers` /
 * `getExecutionCount` from seven each, `getPlans` / `getSubscription` from
 * three. Several fire on the SAME screen (the dashboard home asks for pipelines
 * and members; the org-admin card asks for members again), and every one of them
 * re-issued from scratch on every navigation.
 *
 * Each entry below is a {@link Query} — key, request, freshness — used two ways
 * from one definition: `useQuery(queries.plans())` in a component, and
 * `runQuery(queries.plans(), { signal })` in an event handler or a multi-request
 * page load. Writers call the matching {@link invalidate} member; nobody has to
 * know the key format.
 *
 * NOT cached: anything a mutation returns, and every write. This is a read cache.
 */

import api from './api';
import { CACHE_TTL_MS } from './constants';
import { invalidateQueries, type Query } from './query-cache';
import type { SessionMeta } from './api/domains/auth';
import type { Pipeline, Plugin, TotpStatus } from '@/types';
import type { CatalogEntry, ShadowingEntry } from '@/types/plugin-installs';

/**
 * Stable key fragment for a params object — sorted, `undefined` dropped — so
 * `{limit:1, search:''}` and `{search:'', limit:1}` are one cache entry rather
 * than two.
 */
function stable(params?: Record<string, unknown>): string {
  if (!params) return '';
  return Object.keys(params)
    .filter((k) => params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
}

/**
 * Key prefixes. Keys are deliberately NOT org-scoped: the cache is dropped
 * wholesale at every identity boundary (`clearQueryCache`, called from useAuth
 * on org switch, sign-out and session expiry), which is a stronger guarantee
 * than hoping every key remembered to include the org.
 */
const PREFIX = {
  pipelines: 'pipelines?',
  organizations: 'organizations?',
  orgMembers: 'org-members/',
  executionCount: 'execution-count?',
  plans: 'plans',
  subscription: 'subscription',
  totpStatus: 'totp-status',
  sessions: 'sessions',
  plugins: 'plugins/',
} as const;

type PipelineParams = Record<string, string>;
type OrgParams = Parameters<typeof api.listOrganizations>[0];
type MemberParams = Parameters<typeof api.getOrganizationMembers>[1];
type ExecCountParams = Parameters<typeof api.getExecutionCount>[0];

export const queries = {
  listPipelines: (params?: PipelineParams): Query<Awaited<ReturnType<typeof api.listPipelines>>> => ({
    key: `${PREFIX.pipelines}${stable(params)}`,
    run: (signal) => api.listPipelines(params, { signal }),
  }),

  /** EVERY matching pipeline, cursor-drained and trimmed to `fields` (see
   *  `api.listAllPipelines`). Keyed under the pipelines prefix, so
   *  `invalidate.pipelines()` drops it along with the paged reads. */
  allPipelines: <K extends keyof Pipeline>(
    fields: readonly K[],
    params?: PipelineParams,
  ): Query<Array<Pick<Pipeline, K | 'id'>>> => ({
    key: `${PREFIX.pipelines}all&fields=${fields.join(',')}&${stable(params)}`,
    run: (signal) => api.listAllPipelines(fields, params, { signal }),
  }),

  listOrganizations: (params?: OrgParams): Query<Awaited<ReturnType<typeof api.listOrganizations>>> => ({
    key: `${PREFIX.organizations}${stable(params as Record<string, unknown> | undefined)}`,
    run: (signal) => api.listOrganizations(params, { signal }),
  }),

  orgMembers: (orgId: string, params?: MemberParams): Query<Awaited<ReturnType<typeof api.getOrganizationMembers>>> => ({
    key: `${PREFIX.orgMembers}${orgId}?${stable(params as Record<string, unknown> | undefined)}`,
    run: (signal) => api.getOrganizationMembers(orgId, params, { signal }),
  }),

  executionCount: (params?: ExecCountParams): Query<Awaited<ReturnType<typeof api.getExecutionCount>>> => ({
    key: `${PREFIX.executionCount}${stable(params as Record<string, unknown> | undefined)}`,
    run: (signal) => api.getExecutionCount(params, { signal }),
  }),

  /** The plan catalog barely changes within a session, so it gets a longer
   *  window than the default: the signup picker, the onboarding picker and both
   *  billing pages then share one request. */
  plans: (): Query<Awaited<ReturnType<typeof api.getPlans>>> => ({
    key: PREFIX.plans,
    run: (signal) => api.getPlans({ signal }),
    staleMs: CACHE_TTL_MS,
  }),

  subscription: (): Query<Awaited<ReturnType<typeof api.getSubscription>>> => ({
    key: PREFIX.subscription,
    run: (signal) => api.getSubscription({ signal }),
  }),

  /** The account's authenticator-app state. The Security page asks three times
   *  over (the posture strip, the TOTP panel, the recovery-code row), which is
   *  three requests for one answer.
   *
   *  It THROWS on a failed read rather than resolving to "off": on a security
   *  surface a false negative reads as "nothing is protecting this account",
   *  and every caller would otherwise have to re-derive that rule. */
  totpStatus: (): Query<TotpStatus> => ({
    key: PREFIX.totpStatus,
    run: async (signal) => {
      const res = await api.getTotpStatus({ signal });
      if (!res.success || !res.data) throw new Error('Failed to load two-factor status');
      return res.data.totp;
    },
  }),

  /** Signed-in devices + stored machine credentials. Asked for twice on the
   *  Security page (the posture strip and the sessions panel). Throws on
   *  failure for the same reason as {@link queries.totpStatus} — a false-empty
   *  reads as "nothing is signed in" when devices may well be. */
  /** The org's active plugins (the pipeline editor's picker). Rarely changes
   *  within a session, so it keeps the longer window. */
  activePlugins: (): Query<Plugin[]> => ({
    key: `${PREFIX.plugins}active`,
    run: async (signal) => (await api.listPlugins({ limit: '500', isActive: 'true' }, { signal })).data?.plugins ?? [],
    staleMs: CACHE_TTL_MS,
  }),

  /**
   * The in-app catalog the pipeline editor resolves listings from (every listed
   * listing with its install state), plus the org's shadowing report. `GET
   * /plugins` returns only the org's own rows, so Official and installed
   * listings reach the editor only through here. Each half fails soft on its
   * own — a catalog outage must not take the editor's own-plugin list with it.
   */
  pluginCatalog: (): Query<{ entries: CatalogEntry[]; shadowing: ShadowingEntry[] }> => ({
    key: `${PREFIX.plugins}catalog`,
    run: async (signal) => {
      const [entries, shadowing] = await Promise.all([
        api.getAllPluginCatalog({ signal }).catch(() => [] as CatalogEntry[]),
        api.getPluginShadowing({ signal }).then((r) => r.data?.shadowing ?? []).catch(() => [] as ShadowingEntry[]),
      ]);
      return { entries, shadowing };
    },
    staleMs: CACHE_TTL_MS,
  }),

  sessions: (): Query<{ sessions: SessionMeta[]; machineSessions: SessionMeta[] }> => ({
    key: PREFIX.sessions,
    run: async (signal) => {
      const res = await api.listSessions({ signal });
      if (!res.success || !res.data) throw new Error('Failed to load sessions');
      return { sessions: res.data.sessions, machineSessions: res.data.machineSessions };
    },
  }),
};

/**
 * Drop cached reads a write has just made wrong. Call these right after the
 * mutation resolves — every mounted `useQuery` on that prefix re-reads.
 */
export const invalidate = {
  pipelines: () => invalidateQueries(PREFIX.pipelines),
  organizations: () => invalidateQueries(PREFIX.organizations),
  /** All orgs' member lists, or one org's. */
  orgMembers: (orgId?: string) =>
    invalidateQueries(orgId ? `${PREFIX.orgMembers}${orgId}?` : PREFIX.orgMembers),
  executionCount: () => invalidateQueries(PREFIX.executionCount),
  plans: () => invalidateQueries(PREFIX.plans),
  subscription: () => invalidateQueries(PREFIX.subscription),
  totpStatus: () => invalidateQueries(PREFIX.totpStatus),
  sessions: () => invalidateQueries(PREFIX.sessions),
  /** The editor's plugin list and catalog — after a plugin write, an install
   *  change or a finished build. */
  plugins: () => invalidateQueries(PREFIX.plugins),
};

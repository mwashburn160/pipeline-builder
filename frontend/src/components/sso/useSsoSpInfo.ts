// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { SsoSpInfo } from '@/types';

/**
 * The SP values for an org, from the SERVER (`GET /organization/:id/idp/sp-info`).
 * The page never derives them from `window.location`: the dashboard can be
 * reached through a hostname that is not the deployment's public one, and an
 * IdP configured with the wrong ACS or redirect URI fails in ways that are
 * miserable to diagnose.
 */
export function useSsoSpInfo(orgId: string): { sp: SsoSpInfo | null; loading: boolean; error: Error | null; refetch: () => void } {
  const res = useFetch(
    async (signal) => (await api.getOwnOrgIdpSpInfo(orgId, { signal })).data?.sp ?? null,
    [orgId],
  );
  return { sp: res.data, loading: res.loading, error: res.error, refetch: res.refetch };
}

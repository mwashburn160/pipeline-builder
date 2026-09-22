// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useFetch } from './useFetch';
import api from '@/lib/api';
import type { EcosystemApprovers } from '@/types/ecosystem';

/**
 * The system org's approver standing, as the console overview
 * reports it: Ecosystem Manager headcount per decision permission, with the
 * staffing floor (3) and the two-person floor (2) already applied server-side.
 * Fails soft: `null` while loading or when the overview can't be read, so no
 * false warning is shown.
 */
export function useEcosystemApprovers(): EcosystemApprovers | null {
  const q = useFetch(async (signal) => {
    try {
      const res = await api.getEcosystemOverview({ signal });
      return res.data?.approvers ?? null;
    } catch {
      return null;
    }
  }, []);
  return q.data ?? null;
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from 'react';
import { queries } from '@/lib/api-cache';
import { runQuery } from '@/lib/query-cache';

/**
 * Shared org picker for the sysadmin Users page. Both the create- and edit-user
 * modals populate the same "Organization" dropdown from the same source, so the
 * fetch lives here once. Best-effort — a failure just leaves the list empty
 * (users can still be created org-less / kept in their current org).
 *
 * Reads through the shared query cache: opening the create modal, then the edit
 * modal, then create again is one request rather than three.
 */
export function useOrgOptions() {
  const [orgOptions, setOrgOptions] = useState<Array<{ id: string; name: string }>>([]);

  const loadOrgOptions = useCallback(() => {
    runQuery(queries.listOrganizations({ limit: 100 }))
      .then((res) => { if (res.success && res.data) setOrgOptions(res.data.organizations.map((o) => ({ id: o.id, name: o.name }))); })
      .catch(() => setOrgOptions([]));
  }, []);

  return { orgOptions, setOrgOptions, loadOrgOptions };
}

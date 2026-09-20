// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Lock } from 'lucide-react';
import type { ComplianceRule } from '@/types/compliance';

/**
 * "Inherited from {parent}" marker for a rule a team inherits from its parent
 * org (`propagateToChildren`). Such a rule is read-only in the team; only the
 * source org can edit or delete it. Renders nothing for a rule the org owns.
 */
export function InheritedBadge({ rule }: { rule: Pick<ComplianceRule, 'inherited' | 'sourceOrgId' | 'sourceOrgName'> }) {
  if (!rule.inherited) return null;
  const source = rule.sourceOrgName || rule.sourceOrgId || 'parent organization';
  return (
    <span
      className="inline-flex items-center gap-1 text-2xs font-medium rounded-full px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300"
      title={`Inherited from ${source}. Read-only here: edit it in ${source}.`}
    >
      <Lock className="h-3 w-3" aria-hidden="true" />
      Inherited from {source}
    </span>
  );
}

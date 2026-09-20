// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Lock } from 'lucide-react';
import type { ComplianceRule } from '@/types/compliance';

/** The shape both the badge and the reason line need. */
type InheritedSource = Pick<ComplianceRule, 'inherited' | 'sourceOrgId' | 'sourceOrgName'>;

/**
 * What to CALL the org a rule is inherited from. The API resolves the parent's
 * display name (best effort); when it couldn't, say so in words rather than
 * printing a raw UUID at someone who has no way to look it up — the id itself
 * stays available as a tooltip for support.
 */
export function inheritedSourceLabel(rule: InheritedSource): string {
  return rule.sourceOrgName || 'the parent organization';
}

/**
 * The one sentence explaining why an inherited rule cannot be changed here.
 * Rendered VISIBLY next to the disabled controls — a `title` tooltip is invisible
 * on touch and skipped by most screen readers, so "why is this greyed out?" had
 * no answer on the devices where it was asked most.
 */
export function inheritedReason(rule: InheritedSource): string {
  return `Set by ${inheritedSourceLabel(rule)} and applied to every team — change it there.`;
}

/**
 * "Inherited from {parent}" marker for a rule a team inherits from its parent
 * org (`propagateToChildren`). Such a rule is read-only in the team; only the
 * source org can edit or delete it. Renders nothing for a rule the org owns.
 *
 * `withReason` adds the visible explanation under the badge (the rule list and
 * the enforced view both use it); the source org's id rides along as a title so
 * support can still correlate it. `reasonId` lets the row's disabled controls
 * point at that sentence with `aria-describedby`, so the explanation reaches a
 * screen reader that never lands on the text itself.
 */
export function InheritedBadge({ rule, withReason = false, reasonId }: {
  rule: InheritedSource;
  withReason?: boolean;
  reasonId?: string;
}) {
  if (!rule.inherited) return null;
  return (
    <>
      <span
        className="inline-flex items-center gap-1 text-2xs font-medium rounded-full px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300"
        title={rule.sourceOrgId ? `Organization id: ${rule.sourceOrgId}` : undefined}
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
        Inherited from {inheritedSourceLabel(rule)}
      </span>
      {withReason && (
        <span id={reasonId} className="block mt-0.5 text-2xs text-fg-muted">{inheritedReason(rule)}</span>
      )}
    </>
  );
}

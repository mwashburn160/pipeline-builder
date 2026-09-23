// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/Badge';
import { SEVERITY_CONFIG } from '@/lib/compliance-styles';
import type { RuleSeverity } from '@/types/compliance';

/**
 * A rule's severity as a badge, in the shared status vocabulary.
 *
 * Three surfaces rendered this from their own copy of the class string; the
 * colour (and the ring that separates `critical` from `error`) now comes from
 * {@link SEVERITY_CONFIG} alone.
 */
export function SeverityBadge({ severity, withIcon = false }: { severity: RuleSeverity; withIcon?: boolean }) {
  const cfg = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.warning;
  const Icon = cfg.icon;
  return (
    <Badge color={cfg.color} className={`${withIcon ? 'gap-1 ' : ''}${cfg.className ?? ''}`}>
      {withIcon && <Icon className="h-3 w-3" />}
      {severity}
    </Badge>
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge } from '@/components/ui/Badge';
import type { PluginSummary } from '@/lib/api/domains/plugins';

/**
 * The Deprecated / Yanked pills (W0.4), each titled with the publisher's
 * message or reason. Yanked wins: a yanked version's deprecation is moot.
 */
export function PluginLifecycleBadges({ plugin }: { plugin: Pick<PluginSummary, 'yankedAt' | 'yankReason' | 'deprecatedAt' | 'deprecationMessage'> }) {
  if (plugin.yankedAt) {
    return (
      <span title={plugin.yankReason ? `Yanked: ${plugin.yankReason}` : 'Yanked'} className="inline-block">
        <Badge color="red">Yanked</Badge>
      </span>
    );
  }
  if (plugin.deprecatedAt) {
    return (
      <span title={plugin.deprecationMessage ? `Deprecated: ${plugin.deprecationMessage}` : 'Deprecated'} className="inline-block">
        <Badge color="yellow">Deprecated</Badge>
      </span>
    );
  }
  return null;
}

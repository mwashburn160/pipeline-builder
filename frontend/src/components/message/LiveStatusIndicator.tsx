// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';

/** Props for the LiveStatusIndicator component. */
interface LiveStatusIndicatorProps {
  /**
   * When true, real-time (SSE) updates have dropped and the inbox is being
   * kept current by polling instead. Renders nothing when false so the
   * indicator never flashes during the normal initial connect.
   */
  paused: boolean;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Subtle, non-alarming badge that appears only while live message updates are
 * paused (SSE dropped, polling fallback active). Reassures the user that the
 * list is still refreshing and that a reconnect is in progress.
 */
export function LiveStatusIndicator({ paused, className = '' }: LiveStatusIndicatorProps) {
  if (!paused) return null;

  return (
    <Badge color="yellow" className={`gap-1 ${className}`}>
      <RefreshCw className="w-3 h-3 animate-spin" aria-hidden />
      <span>Live updates paused — reconnecting…</span>
    </Badge>
  );
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Eye } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';

/**
 * Tooltip / hint for a write control disabled under read-only impersonation.
 * The backend's global guard rejects every non-GET request in that session, so
 * an enabled control would only dead-end on a 403.
 */
export const READ_ONLY_REASON = 'Read-only session — stop impersonating to make changes';

/**
 * Inline note for a form or panel whose write controls are disabled under
 * read-only impersonation, so the greyed-out controls don't read as a bug.
 * Pair with `useAuthGuard().isReadOnly`; renders nothing when `show` is false.
 */
export function ReadOnlyNotice({ show, className }: { show: boolean; className?: string }) {
  if (!show) return null;
  return (
    <Callout variant="neutral" icon={Eye} title="Read-only session" className={className}>
      You&apos;re viewing this account read-only. Changes here are disabled — stop impersonating to make changes.
    </Callout>
  );
}

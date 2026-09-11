// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live per-org execution-status stream. The reporting service pushes an
 * `execution-updated` SSE frame to the org's channel whenever new pipeline events
 * are ingested; this calls `onUpdate` on each frame so a dashboard can refetch
 * live instead of polling. Thin wrapper over {@link useTicketedSSE} (which owns
 * the ticket exchange + reconnect/backoff).
 *
 * @param orgId - org to subscribe to, or null to stay disconnected
 * @param onUpdate - called on every execution-updated frame (e.g. refetch)
 */
import { useTicketedSSE } from './useTicketedSSE';
import api from '@/lib/api';

export function useExecutionStatusStream(orgId: string | null, onUpdate: () => void) {
  return useTicketedSSE({
    subscriptionKey: orgId && api.isAuthenticated() ? orgId : null,
    getTicket: () => api.getExecutionStreamTicket(),
    buildUrl: (ticket) => `/api/reports/execution/stream?ticket=${encodeURIComponent(ticket)}`,
    onMessage: () => onUpdate(),
  });
}

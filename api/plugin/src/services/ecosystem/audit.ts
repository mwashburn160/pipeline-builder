// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin ecosystem's one audit emitter — a thin domain helper over
 * api-core's `recordAudit`: governance actions are recorded under the system org
 * (unless a tenant acted) and name the org they affect.
 */

import { SYSTEM_ORG_ID, recordAudit, type RemoteAuditEvent } from '@pipeline-builder/api-core';

export type PluginAuditAction = RemoteAuditEvent['action'];

/** One plugin-ecosystem audit event. */
export interface EcosystemAuditEvent {
  action: PluginAuditAction;
  /** The acting principal (`actorId(...)`, or a system/anonymous sentinel). */
  actor: string;
  /** The org the action is recorded under: the system org (governance) unless a tenant acted. */
  orgId?: string;
  /** The org the action affects; omitted when there is none. */
  affectedOrgId?: string | null;
  targetType: string;
  targetId?: string;
  details: Record<string, unknown>;
}

/** Emit an ecosystem audit event (fire-and-forget; see the module note). */
export function ecosystemAudit(e: EcosystemAuditEvent): void {
  recordAudit({
    action: e.action,
    actorId: e.actor,
    orgId: e.orgId ?? SYSTEM_ORG_ID,
    ...(e.affectedOrgId ? { affectedOrgId: e.affectedOrgId } : {}),
    targetType: e.targetType,
    ...(e.targetId !== undefined ? { targetId: e.targetId } : {}),
    details: e.details,
  });
}

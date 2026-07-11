// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

const logger = createLogger('alert-destination-service');

type OrgAlertDestination = typeof schema.orgAlertDestination.$inferSelect;
type OrgAlertDestinationInsert = typeof schema.orgAlertDestination.$inferInsert;

export interface DestinationCreate {
  channel: 'slack' | 'webhook' | 'in-app' | 'email';
  target: string;
  label: string;
  minSeverity?: 'warning' | 'critical';
  enabled?: boolean;
}

export interface DestinationUpdate {
  channel?: 'slack' | 'webhook' | 'in-app' | 'email';
  target?: string;
  label?: string;
  minSeverity?: 'warning' | 'critical';
  enabled?: boolean;
}

/**
 * Mask a webhook/Slack URL for read-back via the API. Slack incoming webhooks
 * are bearer-equivalent — anyone with the URL can post to the channel — so we
 * only return the last 12 chars + a leading mask on GETs after creation.
 */
function maskTarget(target: string): string {
  if (!target) return '';
  if (target.length <= 16) return '••••' + target.slice(-4);
  return '••••' + target.slice(-12);
}

/**
 * Org-scoped CRUD for alert notification destinations. Multi-tenant routing:
 * when an alert fires with `tenancy=org` and an `org_id` label, the platform's
 * webhook relay looks up every destination matching that org_id + enabled +
 * severity ≤ minSeverity, and forwards.
 */
export class AlertDestinationService {
  /** Strip + mask the target field for API responses. The caller still knows
   *  *which* destination (label / channel / severity) — they just can't read
   *  back the secret URL. */
  static toApiDestination(d: OrgAlertDestination): Omit<OrgAlertDestination, 'target'> & { target: string; hasTarget: boolean } {
    return { ...d, target: maskTarget(d.target), hasTarget: !!d.target };
  }

  /**
   * Sysadmin cross-tenant list: every alert destination in every org.
   *
   * Caller MUST be in a superadmin tenant context (i.e. wrapped in
   * `runWithTenantContext({ isSuperAdmin: true, ... }, ...)`) so RLS
   * lets the query span tenants. Returns rows sorted by org then label
   * — the UI groups by org client-side.
   */
  async listAllAcrossOrgs(): Promise<OrgAlertDestination[]> {
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.orgAlertDestination)
      .where(isNull(schema.orgAlertDestination.deletedAt))
      .orderBy(asc(schema.orgAlertDestination.orgId), asc(schema.orgAlertDestination.label)));
  }

  /** List all destinations for an org (sorted by label for stable UI ordering). */
  async listForOrg(orgId: string): Promise<OrgAlertDestination[]> {
    return withTenantTx(async (tx) => tx
      .select()
      .from(schema.orgAlertDestination)
      .where(and(
        eq(schema.orgAlertDestination.orgId, orgId),
        isNull(schema.orgAlertDestination.deletedAt),
      ))
      .orderBy(asc(schema.orgAlertDestination.label)));
  }

  /**
   * Find every enabled destination for an org that should receive an alert
   * at the given severity. Used by the webhook relay on the hot path —
   * indexed on `(org_id, enabled)` so the lookup is a single B-tree probe.
   *
   * The webhook-relay endpoint is shared-secret-authenticated (not JWT),
   * so the AsyncLocalStorage tenant context for this call is `{ orgId:
   * undefined, isSuperAdmin: false }`. To still pass RLS once it's enforced,
   * the relay controller wraps this call in `runWithTenantContext({
   * isSuperAdmin: true }, ...)` because Alertmanager is acting as a privileged
   * relay across all orgs. See controllers/alert-destinations.ts:alertWebhook.
   */
  async findForDelivery(orgId: string, severity: 'warning' | 'critical'): Promise<OrgAlertDestination[]> {
    const rows = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.orgAlertDestination)
      .where(and(
        eq(schema.orgAlertDestination.orgId, orgId),
        eq(schema.orgAlertDestination.enabled, true),
        isNull(schema.orgAlertDestination.deletedAt),
      )));

    // Severity filter is small enough to do in JS; keeps the SQL simple.
    return rows.filter((r) => {
      if (severity === 'critical') return true; // critical fires every destination
      return r.minSeverity === 'warning'; // warning only fires warning-tier
    });
  }

  async findById(id: string, orgId: string): Promise<OrgAlertDestination | null> {
    return withTenantTx(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.orgAlertDestination)
        .where(and(
          eq(schema.orgAlertDestination.id, id),
          eq(schema.orgAlertDestination.orgId, orgId),
          isNull(schema.orgAlertDestination.deletedAt),
        ))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async create(input: DestinationCreate, caller: { orgId: string; userId: string }): Promise<OrgAlertDestination> {
    const row: OrgAlertDestinationInsert = {
      orgId: caller.orgId,
      createdBy: caller.userId,
      updatedBy: caller.userId,
      channel: input.channel,
      target: input.target ?? '',
      label: input.label,
      minSeverity: input.minSeverity ?? 'warning',
      enabled: input.enabled ?? true,
    };
    const created = await withTenantTx(async (tx) => {
      const [c] = await tx.insert(schema.orgAlertDestination).values(row).returning();
      return c;
    });
    logger.info('Alert destination created', {
      id: created.id, orgId: caller.orgId, channel: created.channel, label: created.label,
    });
    return created;
  }

  async update(
    id: string,
    input: DestinationUpdate,
    caller: { orgId: string; userId: string },
  ): Promise<OrgAlertDestination | null> {
    const updates: Partial<OrgAlertDestinationInsert> = { updatedBy: caller.userId };
    if (input.channel !== undefined) updates.channel = input.channel;
    // Empty-string target on update means "leave existing target alone" — the
    // GET endpoint masks the value, so a client-side edit form that doesn't
    // re-enter the secret would otherwise wipe it.
    if (input.target !== undefined && input.target !== '') updates.target = input.target;
    if (input.label !== undefined) updates.label = input.label;
    if (input.minSeverity !== undefined) updates.minSeverity = input.minSeverity;
    if (input.enabled !== undefined) updates.enabled = input.enabled;

    return withTenantTx(async (tx) => {
      const [updated] = await tx
        .update(schema.orgAlertDestination)
        .set(updates)
        .where(and(
          eq(schema.orgAlertDestination.id, id),
          eq(schema.orgAlertDestination.orgId, caller.orgId),
          isNull(schema.orgAlertDestination.deletedAt),
        ))
        .returning();
      return updated ?? null;
    });
  }

  async delete(id: string, caller: { orgId: string; userId: string }): Promise<boolean> {
    return withTenantTx(async (tx) => {
      const [deleted] = await tx
        .update(schema.orgAlertDestination)
        .set({ deletedAt: sql`CURRENT_TIMESTAMP`, deletedBy: caller.userId })
        .where(and(
          eq(schema.orgAlertDestination.id, id),
          eq(schema.orgAlertDestination.orgId, caller.orgId),
          isNull(schema.orgAlertDestination.deletedAt),
        ))
        .returning({ id: schema.orgAlertDestination.id });
      return !!deleted;
    });
  }
}

export const alertDestinationService = new AlertDestinationService();

// Back-compat named export — alert-destinations controller imports
// `toApiDestination` directly; delegates to the static method above.
export const toApiDestination = AlertDestinationService.toApiDestination;

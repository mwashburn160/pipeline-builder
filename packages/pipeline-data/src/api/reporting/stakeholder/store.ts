// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistence for stakeholder reports: definitions, runs, share links and
 * recipients.
 *
 * Hand-rolled rather than four `CrudService` subclasses because none of these is
 * a generic listable entity with an `isDefault` slot and project-scoped access
 * control. What they need instead is a small number of exact operations with
 * invariants the generic base cannot express:
 *
 *  - A RUN IS APPEND-ONLY once published. Regenerating a period inserts version
 *    N+1 and points the old row at it (`supersededBy`); nothing overwrites a
 *    snapshot a manager has already read.
 *  - A SHARE LINK IS RESOLVED WITHOUT A TENANT. The reader has no account, so the
 *    lookup by token hash is the one read here that deliberately runs as sysadmin
 *    — see {@link resolveShareLink} for why that is the narrowest safe shape.
 *  - A RECIPIENT IS UPSERTED, NEVER RE-CREATED. Re-adding an address must keep its
 *    verification and unsubscribe state, or an unsubscribe could be undone by
 *    deleting and re-adding the row.
 *
 * Everything else runs inside the caller's ambient tenant context (established by
 * `withTenantContext()` at the request boundary), so RLS is the tenancy gate and
 * an `orgId` argument is a redundant second check rather than the only one.
 */

import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { NotFoundError, ConflictError, ErrorCode } from '@pipeline-builder/api-core';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema } from '../../../database/drizzle-schema.js';
import type {
  ReportCadence,
  ReportDefinition,
  ReportPauseReason,
  ReportRecipient,
  ReportRun,
  ReportRunStatus,
  ReportScope,
  ReportShareLink,
  ReportTemplate,
} from '../../../database/schema/reporting-stakeholder.js';
import { runWithTenantContext, withTenantTx } from '../../../database/tenancy.js';
import { softDeleteRetentionMs } from '../../crud-service.js';

/** How long a freshly minted share link lives when the caller names no window. */
export const DEFAULT_SHARE_LINK_TTL_DAYS = 30;
/** The longest a share link may live. Beyond this it is a permanent URL. */
export const MAX_SHARE_LINK_TTL_DAYS = 180;
/** A recipient's verification link. Short: it is clicked within minutes or never. */
export const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Bounces before an address is treated as undeliverable and skipped. Three, not
 * one: a single bounce is often an out-of-office autoresponder or a full mailbox,
 * and dropping a manager off the list for one of those is a silent failure.
 */
export const MAX_BOUNCES = 3;

/** SHA-256 hex of a token. The only form any token is ever stored in. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A fresh URL-safe token, and its hash. The raw value is returned exactly once. */
export function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** What creating a definition needs. */
export interface CreateDefinitionInput {
  orgId: string;
  name: string;
  template: ReportTemplate;
  sections: string[];
  cadence: ReportCadence;
  timezone: string;
  weekStart: 'monday' | 'sunday';
  scope: ReportScope;
  recipients: string[];
  autoSend: boolean;
  ownerId: string;
  createdBy: string;
  nextRunAt?: Date | null;
}

/** The mutable half of a definition. */
export interface UpdateDefinitionInput {
  name?: string;
  template?: ReportTemplate;
  sections?: string[];
  cadence?: ReportCadence;
  timezone?: string;
  weekStart?: 'monday' | 'sunday';
  scope?: ReportScope;
  recipients?: string[];
  autoSend?: boolean;
  isActive?: boolean;
  pausedReason?: ReportPauseReason | null;
  nextRunAt?: Date | null;
}

/** A share link plus the one-time token, returned only from the mint call. */
export interface MintedShareLink {
  link: ReportShareLink;
  /** Shown once. Never stored, never logged, never in a response again. */
  token: string;
}

/** What the public route needs: the link, its run, and the owning org. */
export interface ResolvedShareLink {
  link: ReportShareLink;
  run: ReportRun;
}

/** The `purge_after` stamp a soft-delete carries, or `{}` when purging is off. */
function purgeStamp(now: Date): { purgeAfter?: Date } {
  const ms = softDeleteRetentionMs();
  return ms > 0 ? { purgeAfter: new Date(now.getTime() + ms) } : {};
}

export class StakeholderReportStore {
  // ── Definitions ────────────────────────────────────────────────────────────

  async createDefinition(input: CreateDefinitionInput): Promise<ReportDefinition> {
    const id = randomUUID();
    const rows = await withTenantTx((tx) => tx.insert(schema.reportDefinition).values({
      id,
      orgId: input.orgId,
      ownerId: input.ownerId,
      name: input.name,
      template: input.template,
      sections: input.sections,
      cadence: input.cadence,
      timezone: input.timezone,
      weekStart: input.weekStart,
      scope: input.scope,
      recipients: input.recipients,
      autoSend: input.autoSend,
      nextRunAt: input.nextRunAt ?? null,
      createdBy: input.createdBy,
    }).returning());
    return (rows as ReportDefinition[])[0];
  }

  async listDefinitions(orgId: string): Promise<ReportDefinition[]> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportDefinition)
      .where(and(eq(schema.reportDefinition.orgId, orgId), isNull(schema.reportDefinition.deletedAt)))
      .orderBy(asc(schema.reportDefinition.name)));
    return rows as ReportDefinition[];
  }

  async getDefinition(orgId: string, id: string): Promise<ReportDefinition | null> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportDefinition)
      .where(and(
        eq(schema.reportDefinition.id, id),
        eq(schema.reportDefinition.orgId, orgId),
        isNull(schema.reportDefinition.deletedAt),
      ))
      .limit(1));
    return (rows as ReportDefinition[])[0] ?? null;
  }

  /** Throws {@link NotFoundError} rather than returning null, for route bodies. */
  async requireDefinition(orgId: string, id: string): Promise<ReportDefinition> {
    const found = await this.getDefinition(orgId, id);
    if (!found) throw new NotFoundError('Report definition not found');
    return found;
  }

  async updateDefinition(
    orgId: string,
    id: string,
    patch: UpdateDefinitionInput,
    updatedBy: string,
  ): Promise<ReportDefinition> {
    const set: Record<string, unknown> = { updatedBy, updatedAt: new Date() };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) set[key] = value;
    }
    const rows = await withTenantTx((tx) => tx.update(schema.reportDefinition).set(set)
      .where(and(
        eq(schema.reportDefinition.id, id),
        eq(schema.reportDefinition.orgId, orgId),
        isNull(schema.reportDefinition.deletedAt),
      ))
      .returning());
    const updated = (rows as ReportDefinition[])[0];
    if (!updated) throw new NotFoundError('Report definition not found');
    return updated;
  }

  /**
   * Hand a definition to a new owner. The owner is who a scheduled run is
   * authorized AS, so this is a privilege move, not a metadata edit — the route
   * checks the new owner is a live member of the org before calling.
   */
  async transferOwner(orgId: string, id: string, newOwnerId: string, actorId: string): Promise<ReportDefinition> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportDefinition)
      .set({
        ownerId: newOwnerId,
        updatedBy: actorId,
        updatedAt: new Date(),
        // A definition paused because its previous owner lost access is live again
        // under an owner who has it. The scheduler re-checks every run anyway, so
        // the worst case is one more paused run, never a standing grant.
        isActive: true,
        pausedReason: null,
      })
      .where(and(
        eq(schema.reportDefinition.id, id),
        eq(schema.reportDefinition.orgId, orgId),
        isNull(schema.reportDefinition.deletedAt),
      ))
      .returning());
    const updated = (rows as ReportDefinition[])[0];
    if (!updated) throw new NotFoundError('Report definition not found');
    return updated;
  }

  /**
   * Pause every definition a user owns, with the reason recorded. Called when the
   * owner is deactivated or loses `reports:author` — a report must stop when the
   * person accountable for it can no longer see the data behind it.
   *
   * Returns the paused definitions so the caller can notify an org admin: a
   * silently stopped weekly report is discovered by a manager not receiving it.
   */
  async pauseDefinitionsForOwner(
    orgId: string,
    ownerId: string,
    reason: ReportPauseReason,
  ): Promise<ReportDefinition[]> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportDefinition)
      .set({ isActive: false, pausedReason: reason, updatedAt: new Date() })
      .where(and(
        eq(schema.reportDefinition.orgId, orgId),
        eq(schema.reportDefinition.ownerId, ownerId),
        eq(schema.reportDefinition.isActive, true),
        isNull(schema.reportDefinition.deletedAt),
      ))
      .returning());
    return rows as ReportDefinition[];
  }

  async deleteDefinition(orgId: string, id: string, deletedBy: string): Promise<void> {
    const now = new Date();
    const rows = await withTenantTx((tx) => tx.update(schema.reportDefinition)
      .set({ deletedAt: now, deletedBy, ...purgeStamp(now) })
      .where(and(
        eq(schema.reportDefinition.id, id),
        eq(schema.reportDefinition.orgId, orgId),
        isNull(schema.reportDefinition.deletedAt),
      ))
      .returning({ id: schema.reportDefinition.id }));
    if ((rows as unknown[]).length === 0) {
      throw new NotFoundError('Report definition not found');
    }
    // Links to this definition's runs are revoked in the same breath. Deleting a
    // report while a public URL to last month's numbers keeps working is the kind
    // of gap nobody notices until it matters.
    await this.revokeLinksForDefinition(orgId, id, deletedBy);
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  /**
   * Insert a run for a period, or return the existing one.
   *
   * Idempotent on (definition, periodStart, version): a retry, a catch-up pass
   * and a manual backfill can all ask for the same period, and without this each
   * would insert a row and the lead would review three copies. `onConflictDoNothing`
   * plus a re-read is deliberate — the unique index is the arbiter, so two pods
   * racing produce one row whichever wins.
   */
  async createRun(input: {
    orgId: string;
    definitionId: string;
    periodStart: Date;
    periodEnd: Date;
    periodLabel: string;
    version?: number;
    status?: ReportRunStatus;
    snapshot?: Record<string, unknown> | null;
    failureReason?: string | null;
  }): Promise<{ run: ReportRun; created: boolean }> {
    const version = input.version ?? 1;
    const id = randomUUID();
    const rows = await withTenantTx((tx) => tx.insert(schema.reportRun).values({
      id,
      orgId: input.orgId,
      definitionId: input.definitionId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      periodLabel: input.periodLabel,
      version,
      status: input.status ?? 'drafting',
      snapshot: input.snapshot ?? null,
      failureReason: input.failureReason ?? null,
    }).onConflictDoNothing({
      target: [schema.reportRun.definitionId, schema.reportRun.periodStart, schema.reportRun.version],
    }).returning());
    const inserted = (rows as ReportRun[])[0];
    if (inserted) return { run: inserted, created: true };

    const existing = await withTenantTx((tx) => tx.select().from(schema.reportRun)
      .where(and(
        eq(schema.reportRun.definitionId, input.definitionId),
        eq(schema.reportRun.periodStart, input.periodStart),
        eq(schema.reportRun.version, version),
      ))
      .limit(1));
    const found = (existing as ReportRun[])[0];
    if (!found) {
      // The insert was skipped by the conflict target but nothing is there to
      // read: the only way is a concurrent delete between the two statements.
      throw new ConflictError('Report run could not be created', ErrorCode.CONFLICT, {
        definitionId: input.definitionId,
        periodLabel: input.periodLabel,
      });
    }
    return { run: found, created: false };
  }

  /** The next version number for a period: `max(version) + 1`. */
  async nextVersion(definitionId: string, periodStart: Date): Promise<number> {
    const rows = await withTenantTx((tx) => tx.select({ version: schema.reportRun.version })
      .from(schema.reportRun)
      .where(and(
        eq(schema.reportRun.definitionId, definitionId),
        eq(schema.reportRun.periodStart, periodStart),
      ))
      .orderBy(desc(schema.reportRun.version))
      .limit(1));
    const top = (rows as Array<{ version: number }>)[0];
    return (top?.version ?? 0) + 1;
  }

  /** Point an older run at the version that replaced it. */
  async supersede(orgId: string, oldRunId: string, newRunId: string): Promise<void> {
    await withTenantTx((tx) => tx.update(schema.reportRun)
      .set({ supersededBy: newRunId, updatedAt: new Date() })
      .where(and(eq(schema.reportRun.id, oldRunId), eq(schema.reportRun.orgId, orgId))));
  }

  async listRuns(orgId: string, definitionId: string, limit = 50): Promise<ReportRun[]> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportRun)
      .where(and(
        eq(schema.reportRun.orgId, orgId),
        eq(schema.reportRun.definitionId, definitionId),
        isNull(schema.reportRun.deletedAt),
      ))
      .orderBy(desc(schema.reportRun.periodStart), desc(schema.reportRun.version))
      .limit(limit));
    return rows as ReportRun[];
  }

  async getRun(orgId: string, id: string): Promise<ReportRun | null> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportRun)
      .where(and(eq(schema.reportRun.id, id), eq(schema.reportRun.orgId, orgId), isNull(schema.reportRun.deletedAt)))
      .limit(1));
    return (rows as ReportRun[])[0] ?? null;
  }

  async requireRun(orgId: string, id: string): Promise<ReportRun> {
    const found = await this.getRun(orgId, id);
    if (!found) throw new NotFoundError('Report run not found');
    return found;
  }

  /** Store a computed snapshot and move the run to `ready_for_review`. */
  async completeRun(
    orgId: string,
    id: string,
    snapshot: Record<string, unknown>,
    status: ReportRunStatus = 'ready_for_review',
  ): Promise<ReportRun> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportRun)
      .set({ snapshot, status, failureReason: null, updatedAt: new Date() })
      .where(and(eq(schema.reportRun.id, id), eq(schema.reportRun.orgId, orgId), isNull(schema.reportRun.deletedAt)))
      .returning());
    const updated = (rows as ReportRun[])[0];
    if (!updated) throw new NotFoundError('Report run not found');
    return updated;
  }

  async failRun(orgId: string, id: string, failureReason: string): Promise<void> {
    await withTenantTx((tx) => tx.update(schema.reportRun)
      .set({ status: 'failed', failureReason, updatedAt: new Date() })
      .where(and(eq(schema.reportRun.id, id), eq(schema.reportRun.orgId, orgId))));
  }

  /**
   * Edit the lead's own words on a run that has NOT been published.
   *
   * Refused after publish: the notes are part of what the manager read, and a
   * report whose narrative can be edited after delivery is a report whose
   * delivered version cannot be reconstructed. Regenerating produces version N+1,
   * which is the supported way to correct a published report.
   */
  async setRunNotes(
    orgId: string,
    id: string,
    patch: { leadNotes?: string; aiDraft?: string },
  ): Promise<ReportRun> {
    const run = await this.requireRun(orgId, id);
    if (run.status === 'published') {
      throw new ConflictError(
        'This report has already been published. Regenerate it to produce a new version with your changes — '
        + 'the published version stays exactly as the recipients read it.',
        ErrorCode.CONFLICT,
        { runId: id, publishedAt: run.publishedAt?.toISOString() },
      );
    }
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.leadNotes !== undefined) set.leadNotes = patch.leadNotes;
    if (patch.aiDraft !== undefined) set.aiDraft = patch.aiDraft;
    const rows = await withTenantTx((tx) => tx.update(schema.reportRun).set(set)
      .where(and(eq(schema.reportRun.id, id), eq(schema.reportRun.orgId, orgId), isNull(schema.reportRun.deletedAt)))
      .returning());
    return (rows as ReportRun[])[0];
  }

  /**
   * Record what happened when a run was delivered.
   *
   * Deliberately NOT part of {@link setRunNotes}, which refuses a published run: delivery
   * happens AT publish, so a method that refused published runs could never record it.
   * This one writes exactly one column and nothing else, which is why it is safe to allow
   * after publish — it cannot change a number a recipient has read.
   */
  async recordDelivery(orgId: string, id: string, delivery: Record<string, unknown>): Promise<void> {
    await withTenantTx((tx) => tx.update(schema.reportRun)
      .set({ delivery, updatedAt: new Date() })
      .where(and(
        eq(schema.reportRun.id, id),
        eq(schema.reportRun.orgId, orgId),
        isNull(schema.reportRun.deletedAt),
      )));
  }

  /**
   * Publish a run.
   *
   * Conditional on the row still being unpublished (`published_at IS NULL`), so
   * two clicks — or two tabs — produce one publish and one set of deliveries
   * rather than two. A run with no snapshot cannot be published: there would be
   * nothing for a recipient to read.
   */
  async publishRun(orgId: string, id: string, publishedBy: string): Promise<{ run: ReportRun; alreadyPublished: boolean }> {
    const run = await this.requireRun(orgId, id);
    if (run.status === 'failed' || !run.snapshot) {
      throw new ConflictError(
        'This report has no computed snapshot, so there is nothing to publish. Regenerate it first.',
        ErrorCode.CONFLICT,
        { runId: id, status: run.status },
      );
    }
    const now = new Date();
    const rows = await withTenantTx((tx) => tx.update(schema.reportRun)
      .set({ status: 'published', publishedBy, publishedAt: now, updatedAt: now })
      .where(and(
        eq(schema.reportRun.id, id),
        eq(schema.reportRun.orgId, orgId),
        isNull(schema.reportRun.publishedAt),
        isNull(schema.reportRun.deletedAt),
      ))
      .returning());
    const published = (rows as ReportRun[])[0];
    if (published) return { run: published, alreadyPublished: false };
    // The conditional update matched nothing: someone else published it first.
    return { run: await this.requireRun(orgId, id), alreadyPublished: true };
  }

  // ── Share links ────────────────────────────────────────────────────────────

  /**
   * Mint a read-only link to a published run. The raw token is returned here and
   * nowhere else — only its hash is stored, so a database copy cannot be turned
   * back into working URLs.
   */
  async createShareLink(input: {
    orgId: string;
    runId: string;
    createdBy: string;
    ttlDays?: number;
    redactNames?: boolean;
    now?: Date;
  }): Promise<MintedShareLink> {
    const run = await this.requireRun(input.orgId, input.runId);
    if (run.status !== 'published') {
      throw new ConflictError(
        'Only a published report can be shared. Publish it first — a link to a draft would show numbers the lead has not reviewed.',
        ErrorCode.CONFLICT,
        { runId: input.runId, status: run.status },
      );
    }
    const days = Math.min(input.ttlDays ?? DEFAULT_SHARE_LINK_TTL_DAYS, MAX_SHARE_LINK_TTL_DAYS);
    const now = input.now ?? new Date();
    const { token, tokenHash } = mintToken();
    const rows = await withTenantTx((tx) => tx.insert(schema.reportShareLink).values({
      id: randomUUID(),
      orgId: input.orgId,
      runId: input.runId,
      tokenHash,
      expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      redactNames: input.redactNames ?? false,
      createdBy: input.createdBy,
    }).returning());
    return { link: (rows as ReportShareLink[])[0], token };
  }

  async listShareLinks(orgId: string, runId: string): Promise<ReportShareLink[]> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportShareLink)
      .where(and(eq(schema.reportShareLink.orgId, orgId), eq(schema.reportShareLink.runId, runId)))
      .orderBy(desc(schema.reportShareLink.createdAt)));
    return rows as ReportShareLink[];
  }

  async revokeShareLink(orgId: string, id: string, revokedBy: string): Promise<ReportShareLink> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportShareLink)
      .set({ revokedAt: new Date(), revokedBy })
      .where(and(
        eq(schema.reportShareLink.id, id),
        eq(schema.reportShareLink.orgId, orgId),
        isNull(schema.reportShareLink.revokedAt),
      ))
      .returning());
    const revoked = (rows as ReportShareLink[])[0];
    if (!revoked) throw new NotFoundError('Share link not found or already revoked');
    return revoked;
  }

  /** Revoke every live link to any run of a definition. Used on delete. */
  async revokeLinksForDefinition(orgId: string, definitionId: string, revokedBy: string): Promise<number> {
    const runs = await withTenantTx((tx) => tx.select({ id: schema.reportRun.id }).from(schema.reportRun)
      .where(and(eq(schema.reportRun.orgId, orgId), eq(schema.reportRun.definitionId, definitionId))));
    const runIds = (runs as Array<{ id: string }>).map((r) => r.id);
    if (runIds.length === 0) return 0;
    const rows = await withTenantTx((tx) => tx.update(schema.reportShareLink)
      .set({ revokedAt: new Date(), revokedBy })
      .where(and(
        eq(schema.reportShareLink.orgId, orgId),
        inArray(schema.reportShareLink.runId, runIds),
        isNull(schema.reportShareLink.revokedAt),
      ))
      .returning({ id: schema.reportShareLink.id }));
    return (rows as unknown[]).length;
  }

  /**
   * Resolve a share token to its link and run, for the UNAUTHENTICATED public
   * route.
   *
   * This is the one read in this module that runs as sysadmin, and the reason is
   * structural: the reader holds a token and nothing else — no account, no org,
   * no JWT — so there is no tenant context for RLS to scope by, and the org can
   * only be learned FROM the row. The escalation is kept as narrow as the problem:
   *
   *  - The sysadmin scope covers the token-hash lookup ONLY. The run is read back
   *    under the link's OWN org, so a bug in the run query cannot reach another
   *    tenant's rows.
   *  - The lookup is by a 256-bit hash on a unique index. It is not a filter a
   *    caller can widen — there is no other predicate to influence.
   *  - Expired and revoked links resolve to null here, so the caller cannot
   *    accidentally serve one by forgetting a check.
   *
   * Returns null for every failure — unknown, revoked, expired, or pointing at a
   * run that is no longer published — so the route answers one indistinguishable
   * 404 and a holder of a dead link learns nothing about which of those it was.
   */
  async resolveShareLink(token: string, now = new Date()): Promise<ResolvedShareLink | null> {
    const tokenHash = hashToken(token);
    const links = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx((tx) => tx.select().from(schema.reportShareLink)
        .where(eq(schema.reportShareLink.tokenHash, tokenHash))
        .limit(1)));
    const link = (links as ReportShareLink[])[0];
    // No constant-time comparison here on purpose: the lookup is an equality match
    // on a 256-bit hash over a unique index, so there is no secret-dependent branch
    // in this function to leak. A hand-rolled compare after the database already
    // decided it would be theatre.
    if (!link) return null;
    if (link.revokedAt) return null;
    if (link.expiresAt.getTime() <= now.getTime()) return null;

    const runs = await runWithTenantContext({ orgId: link.orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.select().from(schema.reportRun)
        .where(and(
          eq(schema.reportRun.id, link.runId),
          eq(schema.reportRun.orgId, link.orgId),
          eq(schema.reportRun.status, 'published'),
          isNull(schema.reportRun.deletedAt),
        ))
        .limit(1)));
    const run = (runs as ReportRun[])[0];
    if (!run) return null;
    return { link, run };
  }

  /**
   * Count one human view of a shared report.
   *
   * Separate from {@link resolveShareLink} so the route can serve a link preview,
   * a HEAD probe or a mail scanner's fetch WITHOUT counting it — a view count that
   * jumps the moment a link is pasted into Slack tells the lead their manager read
   * the report when nobody has.
   */
  async recordShareView(link: ReportShareLink, now = new Date()): Promise<void> {
    await runWithTenantContext({ orgId: link.orgId, isSuperAdmin: false }, () =>
      withTenantTx((tx) => tx.update(schema.reportShareLink)
        .set({ viewCount: sql`${schema.reportShareLink.viewCount} + 1`, lastViewedAt: now })
        .where(eq(schema.reportShareLink.id, link.id))));
  }

  // ── Recipients ─────────────────────────────────────────────────────────────

  /**
   * Add (or re-add) a delivery address.
   *
   * Upserts on (org, email) and deliberately does NOT reset `unsubscribed_at` or
   * `verified_at`: a lead must not be able to undo someone's unsubscribe by
   * removing and re-adding them, and an address already verified should not have
   * to confirm twice. A verification token is minted only when the address is not
   * yet verified.
   */
  async upsertRecipient(input: {
    orgId: string;
    email: string;
    displayName?: string;
    createdBy: string;
    /** Set when an admin pre-approved an out-of-domain address. */
    approvedBy?: string | null;
    /** Org members skip verification — they already authenticated to this org. */
    preVerified?: boolean;
    now?: Date;
  }): Promise<{ recipient: ReportRecipient; verificationToken?: string }> {
    const email = input.email.trim().toLowerCase();
    const now = input.now ?? new Date();
    const minted = input.preVerified ? undefined : mintToken();
    // The unsubscribe token is minted for EVERY recipient, member or not, because every
    // report email carries the link. Minted once and kept: a link in a report from March
    // has to keep working.
    const unsub = mintToken();
    const rows = await withTenantTx((tx) => tx.insert(schema.reportRecipient).values({
      id: randomUUID(),
      orgId: input.orgId,
      email,
      displayName: input.displayName ?? null,
      verifiedAt: input.preVerified ? now : null,
      verificationTokenHash: minted?.tokenHash ?? null,
      unsubscribeToken: unsub.token,
      approvedBy: input.approvedBy ?? null,
      createdBy: input.createdBy,
    }).onConflictDoUpdate({
      target: [schema.reportRecipient.orgId, schema.reportRecipient.email],
      set: {
        displayName: input.displayName ?? sql`${schema.reportRecipient.displayName}`,
        // Re-adding a tombstoned recipient revives the row with its history.
        deletedAt: null,
        deletedBy: null,
        purgeAfter: null,
        approvedBy: input.approvedBy ?? sql`${schema.reportRecipient.approvedBy}`,
        // Only mint over an UNVERIFIED row; a verified address keeps its state.
        verificationTokenHash: sql`CASE WHEN ${schema.reportRecipient.verifiedAt} IS NULL
          THEN ${minted?.tokenHash ?? null} ELSE ${schema.reportRecipient.verificationTokenHash} END`,
        verifiedAt: input.preVerified
          ? sql`COALESCE(${schema.reportRecipient.verifiedAt}, ${now})`
          : sql`${schema.reportRecipient.verifiedAt}`,
        // COALESCE, never overwrite: re-adding an address must not break the unsubscribe
        // link in every report already delivered to it.
        unsubscribeToken: sql`COALESCE(${schema.reportRecipient.unsubscribeToken}, ${unsub.token})`,
      },
    }).returning());
    const recipient = (rows as ReportRecipient[])[0];
    // The token is only useful if this row actually took it.
    const tookToken = minted && recipient.verificationTokenHash === minted.tokenHash;
    return { recipient, ...(tookToken ? { verificationToken: minted.token } : {}) };
  }

  async listRecipients(orgId: string): Promise<ReportRecipient[]> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportRecipient)
      .where(and(eq(schema.reportRecipient.orgId, orgId), isNull(schema.reportRecipient.deletedAt)))
      .orderBy(asc(schema.reportRecipient.email)));
    return rows as ReportRecipient[];
  }

  async getRecipients(orgId: string, ids: string[]): Promise<ReportRecipient[]> {
    if (ids.length === 0) return [];
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportRecipient)
      .where(and(
        eq(schema.reportRecipient.orgId, orgId),
        inArray(schema.reportRecipient.id, ids),
        isNull(schema.reportRecipient.deletedAt),
      )));
    return rows as ReportRecipient[];
  }

  /** Mint a fresh verification token for a recipient that has not confirmed yet. */
  async resendVerification(orgId: string, id: string): Promise<{ recipient: ReportRecipient; token: string }> {
    const { token, tokenHash } = mintToken();
    const rows = await withTenantTx((tx) => tx.update(schema.reportRecipient)
      .set({ verificationTokenHash: tokenHash })
      .where(and(
        eq(schema.reportRecipient.id, id),
        eq(schema.reportRecipient.orgId, orgId),
        isNull(schema.reportRecipient.verifiedAt),
        isNull(schema.reportRecipient.deletedAt),
      ))
      .returning());
    const recipient = (rows as ReportRecipient[])[0];
    if (!recipient) {
      throw new ConflictError(
        'This recipient is already verified, or no longer exists.',
        ErrorCode.CONFLICT,
        { recipientId: id },
      );
    }
    return { recipient, token };
  }

  /**
   * Confirm an address from the emailed token. Cross-org by necessity (the person
   * clicking has no session), so it runs as sysadmin over a unique 256-bit hash —
   * the same shape, and the same reasoning, as {@link resolveShareLink}.
   *
   * The token is CONSUMED: it is cleared on success, so a forwarded confirmation
   * link cannot be replayed by whoever the mail was forwarded to.
   */
  async verifyRecipientByToken(token: string, now = new Date()): Promise<ReportRecipient | null> {
    const tokenHash = hashToken(token);
    const rows = await runWithTenantContext({ isSuperAdmin: true }, () =>
      withTenantTx((tx) => tx.update(schema.reportRecipient)
        .set({ verifiedAt: now, verificationTokenHash: null })
        .where(and(
          eq(schema.reportRecipient.verificationTokenHash, tokenHash),
          isNull(schema.reportRecipient.verifiedAt),
          isNull(schema.reportRecipient.deletedAt),
          // A token older than the window is not accepted. `created_at` is the
          // floor for the first token; a resend refreshes the hash, so this bounds
          // the original mint and is deliberately generous.
          sql`${schema.reportRecipient.createdAt} > ${new Date(now.getTime() - VERIFICATION_TTL_MS)}`,
        ))
        .returning()));
    return (rows as ReportRecipient[])[0] ?? null;
  }

  /** Honour an unsubscribe across every definition in the org. */
  async unsubscribeByEmail(orgId: string, email: string, now = new Date()): Promise<boolean> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportRecipient)
      .set({ unsubscribedAt: now })
      .where(and(
        eq(schema.reportRecipient.orgId, orgId),
        eq(schema.reportRecipient.email, email.trim().toLowerCase()),
        isNull(schema.reportRecipient.unsubscribedAt),
      ))
      .returning({ id: schema.reportRecipient.id }));
    return (rows as unknown[]).length > 0;
  }

  /**
   * Honour an unsubscribe from the link in a report email.
   *
   * Looked up by TOKEN across orgs, as sysadmin, for the same reason the share-link
   * resolve is: the person clicking has no account and no tenant, and the token is the
   * only thing that identifies the row. It is the narrowest possible shape — one indexed
   * lookup, one column written, nothing returned to the caller but whether a row
   * matched.
   *
   * Idempotent. A mail client that sends the one-click POST twice, or a manager who
   * clicks again months later, gets the same answer rather than an error page — the
   * second call finds the row already unsubscribed and reports success, because from the
   * clicker's point of view it is.
   */
  async unsubscribeByToken(token: string, now = new Date()): Promise<boolean> {
    if (token.length < 16) return false;
    return runWithTenantContext({ isSuperAdmin: true }, async () => {
      const rows = await withTenantTx((tx) => tx.update(schema.reportRecipient)
        .set({ unsubscribedAt: sql`COALESCE(${schema.reportRecipient.unsubscribedAt}, ${now})` })
        .where(eq(schema.reportRecipient.unsubscribeToken, token))
        .returning({ id: schema.reportRecipient.id }));
      return (rows as unknown[]).length > 0;
    });
  }

  /** Record a delivery bounce. At {@link MAX_BOUNCES} the address is skipped. */
  async recordBounce(orgId: string, email: string, now = new Date()): Promise<number> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportRecipient)
      .set({ bounceCount: sql`${schema.reportRecipient.bounceCount} + 1`, lastBounceAt: now })
      .where(and(
        eq(schema.reportRecipient.orgId, orgId),
        eq(schema.reportRecipient.email, email.trim().toLowerCase()),
      ))
      .returning({ bounceCount: schema.reportRecipient.bounceCount }));
    return (rows as Array<{ bounceCount: number }>)[0]?.bounceCount ?? 0;
  }

  async deleteRecipient(orgId: string, id: string, deletedBy: string): Promise<void> {
    const now = new Date();
    const rows = await withTenantTx((tx) => tx.update(schema.reportRecipient)
      .set({ deletedAt: now, deletedBy, ...purgeStamp(now) })
      .where(and(
        eq(schema.reportRecipient.id, id),
        eq(schema.reportRecipient.orgId, orgId),
        isNull(schema.reportRecipient.deletedAt),
      ))
      .returning({ id: schema.reportRecipient.id }));
    if ((rows as unknown[]).length === 0) {
      throw new NotFoundError('Recipient not found');
    }
  }

  /**
   * Is this address deliverable right now? The single place the delivery rules
   * live, so the scheduler and the UI agree about why a recipient is being
   * skipped.
   */
  deliverability(recipient: ReportRecipient): { deliverable: boolean; reason?: string } {
    if (recipient.deletedAt) return { deliverable: false, reason: 'removed' };
    if (recipient.unsubscribedAt) return { deliverable: false, reason: 'unsubscribed' };
    if (!recipient.verifiedAt) return { deliverable: false, reason: 'pending_verification' };
    if (recipient.bounceCount >= MAX_BOUNCES) return { deliverable: false, reason: 'bouncing' };
    return { deliverable: true };
  }

  // ── Recipient policy ───────────────────────────────────────────────────────

  /**
   * The org's admin-owned report policy. Read through the reporting settings row,
   * which may not exist — an org that has never configured anything gets the
   * closed defaults (no external sharing, no external domains, approval required).
   */
  async getReportPolicy(orgId: string): Promise<{
    externalSharing: boolean;
    recipientDomains: string[] | null;
    requireApproval: boolean;
  }> {
    const rows = await withTenantTx((tx) => tx.select({
      externalSharing: schema.doraSettings.reportExternalSharing,
      recipientDomains: schema.doraSettings.reportRecipientDomains,
      requireApproval: schema.doraSettings.reportRequireApproval,
    }).from(schema.doraSettings).where(eq(schema.doraSettings.orgId, orgId)).limit(1));
    const row = (rows as Array<{ externalSharing: boolean; recipientDomains: string[] | null; requireApproval: boolean }>)[0];
    return {
      externalSharing: row?.externalSharing ?? false,
      recipientDomains: row?.recipientDomains ?? null,
      requireApproval: row?.requireApproval ?? true,
    };
  }

  async setReportPolicy(orgId: string, patch: {
    externalSharing?: boolean;
    recipientDomains?: string[] | null;
    requireApproval?: boolean;
  }): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.externalSharing !== undefined) set.reportExternalSharing = patch.externalSharing;
    if (patch.recipientDomains !== undefined) set.reportRecipientDomains = patch.recipientDomains;
    if (patch.requireApproval !== undefined) set.reportRequireApproval = patch.requireApproval;
    await withTenantTx((tx) => tx.insert(schema.doraSettings).values({
      orgId,
      reportExternalSharing: patch.externalSharing ?? false,
      reportRecipientDomains: patch.recipientDomains ?? null,
      reportRequireApproval: patch.requireApproval ?? true,
    }).onConflictDoUpdate({ target: schema.doraSettings.orgId, set }));
  }

  /**
   * Is `email` admissible as a recipient for this org, and does it need an
   * admin's approval first?
   *
   * `orgMemberEmails` is the set of addresses that already authenticate to this
   * org — they are always admissible and never need verification, because the org
   * has already established they belong to it. Everything else is measured against
   * the allowed-domain list, and a NULL list means "no external addresses at all",
   * not "any address": the closed reading is the one that cannot leak a report by
   * an admin forgetting to configure something.
   */
  admitRecipient(
    email: string,
    policy: { recipientDomains: string[] | null; requireApproval: boolean },
    orgMemberEmails: ReadonlySet<string>,
  ): { admitted: true; member: boolean; needsApproval: boolean } | { admitted: false; reason: string } {
    const normalized = email.trim().toLowerCase();
    if (orgMemberEmails.has(normalized)) return { admitted: true, member: true, needsApproval: false };

    const at = normalized.lastIndexOf('@');
    const domain = at >= 0 ? normalized.slice(at + 1) : '';
    if (!domain) return { admitted: false, reason: 'Not a valid email address.' };

    const allowed = policy.recipientDomains;
    if (!allowed || allowed.length === 0) {
      return {
        admitted: false,
        reason: 'This organization only delivers reports to its own members. '
          + 'An administrator can allow specific external domains in reporting settings.',
      };
    }
    const ok = allowed.some((d) => {
      const clean = d.trim().toLowerCase().replace(/^@/, '');
      return clean.length > 0 && (domain === clean || domain.endsWith(`.${clean}`));
    });
    if (!ok) {
      return {
        admitted: false,
        reason: `Reports can only be sent to ${allowed.join(', ')} addresses in this organization.`,
      };
    }
    return { admitted: true, member: false, needsApproval: policy.requireApproval };
  }

  // ── Retention ──────────────────────────────────────────────────────────────

  /**
   * Hard-delete expired tombstones across every org, for the shared soft-delete
   * sweep. Runs inside the sweep's own sysadmin scope.
   *
   * Runs go first: a purged definition with orphaned runs would leave snapshots
   * nothing can reach, and share links are deleted with their runs so a purge
   * cannot leave a live token pointing at a row that no longer exists.
   */
  purgeableEntities(): Array<{ name: string; purgeExpired(now: Date, limit?: number): Promise<number> }> {
    return [
      { name: 'report_run', purgeExpired: (now, limit) => this.purgeRuns(now, limit) },
      { name: 'report_definition', purgeExpired: (now, limit) => this.purgeDefinitions(now, limit) },
      { name: 'report_recipient', purgeExpired: (now, limit) => this.purgeRecipients(now, limit) },
    ];
  }

  private async purgeRuns(now: Date, limit = 500): Promise<number> {
    return withTenantTx(async (tx) => {
      const due = await tx.select({ id: schema.reportRun.id }).from(schema.reportRun)
        .where(and(sql`${schema.reportRun.deletedAt} IS NOT NULL`, lte(schema.reportRun.purgeAfter, now)))
        .limit(limit);
      const ids = (due as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) return 0;
      await tx.delete(schema.reportShareLink).where(inArray(schema.reportShareLink.runId, ids));
      const gone = await tx.delete(schema.reportRun).where(inArray(schema.reportRun.id, ids))
        .returning({ id: schema.reportRun.id });
      return (gone as unknown[]).length;
    });
  }

  private async purgeDefinitions(now: Date, limit = 500): Promise<number> {
    return withTenantTx(async (tx) => {
      const due = await tx.select({ id: schema.reportDefinition.id }).from(schema.reportDefinition)
        .where(and(
          sql`${schema.reportDefinition.deletedAt} IS NOT NULL`,
          lte(schema.reportDefinition.purgeAfter, now),
        ))
        .limit(limit);
      const ids = (due as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) return 0;
      // The definition's runs (and their links) go with it, tombstoned or not:
      // a snapshot whose definition is gone can never be listed again.
      const runs = await tx.select({ id: schema.reportRun.id }).from(schema.reportRun)
        .where(inArray(schema.reportRun.definitionId, ids));
      const runIds = (runs as Array<{ id: string }>).map((r) => r.id);
      if (runIds.length > 0) {
        await tx.delete(schema.reportShareLink).where(inArray(schema.reportShareLink.runId, runIds));
        await tx.delete(schema.reportRun).where(inArray(schema.reportRun.id, runIds));
      }
      const gone = await tx.delete(schema.reportDefinition).where(inArray(schema.reportDefinition.id, ids))
        .returning({ id: schema.reportDefinition.id });
      return (gone as unknown[]).length;
    });
  }

  private async purgeRecipients(now: Date, limit = 500): Promise<number> {
    return withTenantTx(async (tx) => {
      const due = await tx.select({ id: schema.reportRecipient.id }).from(schema.reportRecipient)
        .where(and(
          sql`${schema.reportRecipient.deletedAt} IS NOT NULL`,
          lte(schema.reportRecipient.purgeAfter, now),
        ))
        .limit(limit);
      const ids = (due as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) return 0;
      const gone = await tx.delete(schema.reportRecipient).where(inArray(schema.reportRecipient.id, ids))
        .returning({ id: schema.reportRecipient.id });
      return (gone as unknown[]).length;
    });
  }

  /** Every definition the owner must be re-checked for, for the pause sweep. */
  async listOwnedDefinitions(orgId: string, ownerId: string): Promise<ReportDefinition[]> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportDefinition)
      .where(and(
        eq(schema.reportDefinition.orgId, orgId),
        eq(schema.reportDefinition.ownerId, ownerId),
        isNull(schema.reportDefinition.deletedAt),
      )));
    return rows as ReportDefinition[];
  }

  // ── The scheduler's reads and writes ───────────────────────────────────────

  /**
   * Definitions whose next run is due, across every org.
   *
   * Runs as SYSADMIN, because the scheduler has no tenant: it is looking for work
   * in orgs it has not been told about. This is the one read here that crosses org
   * boundaries, and it is kept to the narrowest possible shape — the rows needed to
   * claim and execute, ordered oldest-due first so a backlog drains in order rather
   * than starving whichever org sorts last by id.
   *
   * `limit` is the per-cycle ceiling: a cycle that tried to drain everything would
   * hold the leader lock for as long as the slowest org's compose takes, times the
   * number of definitions.
   */
  async dueDefinitions(now: Date, limit: number): Promise<ReportDefinition[]> {
    return runWithTenantContext({ isSuperAdmin: true }, async () => {
      const rows = await withTenantTx((tx) => tx.select().from(schema.reportDefinition)
        .where(and(
          eq(schema.reportDefinition.isActive, true),
          isNull(schema.reportDefinition.deletedAt),
          lte(schema.reportDefinition.nextRunAt, now),
        ))
        .orderBy(asc(schema.reportDefinition.nextRunAt))
        .limit(limit));
      return rows as ReportDefinition[];
    });
  }

  /**
   * Claim a due definition by advancing its `nextRunAt`, but only if it still holds
   * the value the scan saw.
   *
   * THE CONDITIONAL UPDATE IS THE CONCURRENCY GUARD, not the leader lock. The lock
   * stops two replicas sweeping in the same window; it does not stop a sweep that
   * outlives its lock TTL from overlapping the next leader's sweep, and both would
   * then select the same still-due definition. Without the `next_run_at = <seen>`
   * predicate each would advance the schedule and each would compose and DELIVER a
   * report — the same manager gets the same report twice, from two pods, which is
   * the failure everyone notices.
   *
   * Runs as sysadmin for the same reason as the scan, and returns whether the claim
   * won so the caller can simply skip a lost race.
   */
  async claimDefinition(id: string, seenNextRunAt: Date, nextRunAt: Date, now = new Date()): Promise<boolean> {
    return runWithTenantContext({ isSuperAdmin: true }, async () => {
      const claimed = await withTenantTx((tx) => tx.update(schema.reportDefinition)
        .set({ lastRunAt: now, nextRunAt, updatedAt: now })
        .where(and(
          eq(schema.reportDefinition.id, id),
          eq(schema.reportDefinition.nextRunAt, seenNextRunAt),
        ))
        .returning({ id: schema.reportDefinition.id }));
      return (claimed as unknown[]).length > 0;
    });
  }

  /**
   * Set (or clear) a definition's `nextRunAt` without claiming it.
   *
   * Used when a definition is created, resumed, or has its cadence/timezone changed
   * — the schedule has to be re-derived from the calendar rather than left at
   * whatever the old cadence produced.
   */
  async setNextRun(orgId: string, id: string, nextRunAt: Date | null): Promise<void> {
    await withTenantTx((tx) => tx.update(schema.reportDefinition)
      .set({ nextRunAt, updatedAt: new Date() })
      .where(and(
        eq(schema.reportDefinition.orgId, orgId),
        eq(schema.reportDefinition.id, id),
        isNull(schema.reportDefinition.deletedAt),
      )));
  }

  /**
   * Pause ONE definition with the reason, from the scheduler.
   *
   * Separate from {@link pauseDefinitionsForOwner} because the trigger is different:
   * that one is a membership change affecting every definition a person owns, this
   * one is a per-run recheck that failed. Clears `nextRunAt` so a paused definition
   * stops appearing in the due scan at all, rather than being re-claimed and
   * re-rejected every cycle.
   *
   * Runs as sysadmin: the caller is the scheduler, which has no tenant, and the id
   * came from its own cross-org scan.
   */
  async pauseDefinition(id: string, reason: ReportPauseReason): Promise<void> {
    await runWithTenantContext({ isSuperAdmin: true }, async () => {
      await withTenantTx((tx) => tx.update(schema.reportDefinition)
        .set({ isActive: false, pausedReason: reason, nextRunAt: null, updatedAt: new Date() })
        .where(and(
          eq(schema.reportDefinition.id, id),
          isNull(schema.reportDefinition.deletedAt),
        )));
    });
  }

  /**
   * Resume a paused definition, clearing the reason and re-deriving its schedule.
   *
   * `nextRunAt` is supplied by the caller rather than computed here: the period
   * arithmetic needs the definition's timezone and week start, and that belongs with
   * the period resolver, not the store.
   */
  async resumeDefinition(orgId: string, id: string, nextRunAt: Date, actorId: string): Promise<ReportDefinition> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportDefinition)
      .set({ isActive: true, pausedReason: null, nextRunAt, updatedBy: actorId, updatedAt: new Date() })
      .where(and(
        eq(schema.reportDefinition.orgId, orgId),
        eq(schema.reportDefinition.id, id),
        isNull(schema.reportDefinition.deletedAt),
      ))
      .returning());
    const row = (rows as ReportDefinition[])[0];
    if (!row) throw new NotFoundError('Report definition not found');
    return row;
  }

  /**
   * Pause every ACTIVE definition in an org, with the reason.
   *
   * The entitlement lapse leg: billing tells reporting the add-on is gone, and every
   * definition in the account stops. Returns the rows so the caller can notify.
   */
  async pauseDefinitionsForOrg(orgId: string, reason: ReportPauseReason): Promise<ReportDefinition[]> {
    const rows = await withTenantTx((tx) => tx.update(schema.reportDefinition)
      .set({ isActive: false, pausedReason: reason, nextRunAt: null, updatedAt: new Date() })
      .where(and(
        eq(schema.reportDefinition.orgId, orgId),
        eq(schema.reportDefinition.isActive, true),
        isNull(schema.reportDefinition.deletedAt),
      ))
      .returning());
    return rows as ReportDefinition[];
  }

  /**
   * Every definition in an org paused for `reason`, for the resume leg.
   *
   * Scoped to the reason on purpose: re-subscribing must not un-pause a definition
   * whose owner was deactivated. Those are different problems with different fixes,
   * and resuming one by fixing the other is how a report starts running under a
   * person who left.
   */
  async definitionsPausedFor(orgId: string, reason: ReportPauseReason): Promise<ReportDefinition[]> {
    const rows = await withTenantTx((tx) => tx.select().from(schema.reportDefinition)
      .where(and(
        eq(schema.reportDefinition.orgId, orgId),
        eq(schema.reportDefinition.isActive, false),
        eq(schema.reportDefinition.pausedReason, reason),
        isNull(schema.reportDefinition.deletedAt),
      )));
    return rows as ReportDefinition[];
  }
}

export const stakeholderReportStore = new StakeholderReportStore();

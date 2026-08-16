// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { CrudService, schema, withTenantTx, buildMessageConditions, type CrudTx, type MessageFilter, type PaginatedResult, type QueryOptions } from '@pipeline-builder/pipeline-data';
import { SQL, eq, and, or, sql, inArray } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { deleteAttachments } from './attachment-storage.js';

type Message = typeof schema.message.$inferSelect;
type MessageInsert = typeof schema.message.$inferInsert;
type MessageUpdate = Partial<Omit<MessageInsert, 'id' | 'createdAt' | 'createdBy'>>;

/** Cache for message reads — announcements/conversations are stable between mutations. */
const messageCache = createCacheService('message:', CoreConstants.CACHE_TTL_MESSAGE);

/**
 * Service for managing internal messages between organizations and system org.
 *
 * Supports:
 * - Announcements: System org broadcasts to all orgs
 * - Conversations: Two-way threaded messaging between org and system org
 * - Thread management, read tracking, and unread counts
 */
export class MessageService extends CrudService<Message, MessageFilter, MessageInsert, MessageUpdate> {
  protected get schema(): PgTable {
    return schema.message as PgTable;
  }

  protected buildConditions(filter: Partial<MessageFilter>, orgId: string): SQL[] {
    return buildMessageConditions(filter, orgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const sortableColumns: Record<string, AnyColumn> = {
      id: schema.message.id,
      createdAt: schema.message.createdAt,
      updatedAt: schema.message.updatedAt,
      subject: schema.message.subject,
      messageType: schema.message.messageType,
      priority: schema.message.priority,
    };
    return sortableColumns[sortBy] || null;
  }

  protected getProjectColumn(): AnyColumn | null {
    return null; // Messages are org-scoped, not project-scoped
  }

  protected getOrgColumn(): AnyColumn {
    return schema.message.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.message.id];
  }

  // -- Cache invalidation on mutations --

  /**
   * Invalidate every cached view a message touches: BOTH the sender (`orgId`) and
   * the recipient (`recipientOrgId`) sides. Keying only on the sender left
   * recipients (and announcement audiences) serving stale inbox/unread lists for
   * the full cache TTL. A broadcast (`recipientOrgId='*'`) invalidates every org's
   * announcement view.
   */
  private async invalidateMessageCaches(orgId?: string, recipientOrgId?: string | null): Promise<void> {
    const patterns = new Set<string>();
    if (orgId) patterns.add(`${orgId}:*`);
    if (recipientOrgId && recipientOrgId !== '*') patterns.add(`${recipientOrgId}:*`);
    // Broadcast: drop EVERY org's cached announcement pages. The trailing `*`
    // matches the per-page key suffix (`:limit:offset:sortBy:sortOrder`) added
    // when these views were paginated — `*:announcements` (no trailing glob)
    // would miss the paginated keys and serve a stale announcements feed.
    if (recipientOrgId === '*') patterns.add('*:announcements*');
    await Promise.all([...patterns].map((p) => messageCache.invalidatePattern(p)));
  }

  protected async onAfterCreate(entity: Message): Promise<void> {
    await this.invalidateMessageCaches(entity.orgId, entity.recipientOrgId);
  }

  protected async onAfterUpdate(_id: string, entity: Message): Promise<void> {
    await this.invalidateMessageCaches(entity.orgId, entity.recipientOrgId);
  }

  protected async onAfterDelete(_id: string, entity: Message): Promise<void> {
    await this.invalidateMessageCaches(entity.orgId, entity.recipientOrgId);
  }

  /**
   * Cascade attachment teardown when messages are HARD-purged (retention sweep).
   * Runs inside the purge transaction (sysadmin-scoped, so it spans all orgs):
   * deletes the attachment metadata rows for the doomed messages and reclaims
   * their object-storage blobs. Blob deletion is best-effort (never throws) — an
   * orphaned blob is housekeeping, not data loss, and must not abort the purge.
   */
  protected async onBeforePurge(ids: string[], tx: CrudTx): Promise<void> {
    if (ids.length === 0) return;
    const removed = await tx
      .delete(schema.messageAttachment)
      .where(inArray(schema.messageAttachment.messageId, ids))
      .returning({ storageKey: schema.messageAttachment.storageKey });
    await deleteAttachments((removed as Array<{ storageKey: string }>).map((r) => r.storageKey));
  }

  /**
   * Get all reply messages in a thread (excludes the root message).
   *
   * @param threadId - ID of the root message
   * @param orgId - Organization ID for access control
   * @returns Array of reply messages in the thread
   */
  async findThreadMessages(threadId: string, orgId: string, viewerUserId?: string): Promise<Message[]> {
    return this.find(
      { threadId, isActive: true, ...(viewerUserId ? { viewerUserId } : {}) } as Partial<MessageFilter>,
      orgId,
    );
  }

  /**
   * Get a single visible message by id for a specific viewer. Mirrors
   * `findById` but threads the viewer's `userId` through the shared
   * `buildMessageConditions` so a per-user targeted message is returned only to
   * its target (plus the sender org / system org) — a bare `findById(id, orgId)`
   * would otherwise hand any member of the recipient org a message addressed to
   * one specific user. Returns null when not visible / not found / inactive.
   */
  async findVisibleById(id: string, orgId: string, viewerUserId?: string): Promise<Message | null> {
    const [message] = await this.find(
      { id, isActive: true, ...(viewerUserId ? { viewerUserId } : {}) } as Partial<MessageFilter>,
      orgId,
    );
    return (message as Message) ?? null;
  }

  /**
   * Get inbox: root messages (threadId is null) of a given type, PAGINATED and
   * hard-capped. Delegates to `findPaginated`, which clamps `limit` to
   * MAX_PAGE_LIMIT — so the announcements/conversations views can never fetch (or
   * cache) an unbounded result set the way the previous `find(...)` did.
   *
   * Announcements (recipientOrgId='*') are surfaced to every org; the shared
   * `buildMessageConditions` (via buildConditions) applies the sender/recipient/
   * broadcast + system-org visibility, so callers filter only by `messageType`.
   *
   * @param orgId - Organization ID for access control
   * @param messageType - announcement or conversation
   * @param options - Pagination + sort (limit clamped to MAX_PAGE_LIMIT)
   * @returns Paginated page of root messages
   */
  async findInboxPaginated(
    orgId: string,
    messageType: 'announcement' | 'conversation',
    options: QueryOptions = {},
    viewerUserId?: string,
  ): Promise<PaginatedResult<Message>> {
    const filter: Partial<MessageFilter> = {
      isActive: true,
      threadId: null, // SQL-level IS NULL — root messages only
      messageType,
      ...(viewerUserId ? { viewerUserId } : {}),
    };
    return this.findPaginated(filter, orgId, options);
  }

  /**
   * Per-page cache key so distinct pages/sorts don't collide or over-cache.
   * `viewerUserId` is part of the key because per-user targeted conversations
   * make a page VIEWER-SPECIFIC — without it, user A's cached conversations page
   * (which may include a message targeted only at A) could be served to user B
   * in the same org. Announcements are org-wide (never user-targeted), so their
   * key leaves the viewer segment empty and stays shared per-org.
   */
  private inboxCacheKey(orgId: string, view: 'announcements' | 'conversations', o: QueryOptions, viewerUserId?: string): string {
    return `${orgId}:${view}:${viewerUserId ?? ''}:${o.limit ?? ''}:${o.offset ?? ''}:${o.sortBy ?? ''}:${o.sortOrder ?? ''}`;
  }

  /**
   * Get announcements visible to an org (paginated + hard-capped, per-page cached).
   *
   * @param orgId - Organization ID for access control
   * @param options - Pagination + sort options
   * @returns Paginated page of announcement root messages
   */
  async findAnnouncements(orgId: string, options: QueryOptions = {}): Promise<PaginatedResult<Message>> {
    return messageCache.getOrSet(
      this.inboxCacheKey(orgId, 'announcements', options),
      () => this.findInboxPaginated(orgId, 'announcement', options),
    );
  }

  /**
   * Get conversations for an org (paginated + hard-capped, per-page cached).
   *
   * @param orgId - Organization ID for access control
   * @param options - Pagination + sort options
   * @returns Paginated page of conversation root messages
   */
  async findConversations(orgId: string, options: QueryOptions = {}, viewerUserId?: string): Promise<PaginatedResult<Message>> {
    return messageCache.getOrSet(
      this.inboxCacheKey(orgId, 'conversations', options, viewerUserId),
      () => this.findInboxPaginated(orgId, 'conversation', options, viewerUserId),
    );
  }

  /**
   * Mark a single message as read for the calling org.
   * Stamps `readBy[orgId] = now()` — per-participant. The recipient
   * marking the thread does NOT flip the sender's view.
   *
   * @param id - Message ID
   * @param orgId - Organization ID — scopes access AND identifies the reader
   * @param userId - User performing the action (for updatedBy)
   * @returns Updated message, or null if not found
   */
  async markAsRead(id: string, orgId: string, userId: string): Promise<Message | null> {
    const now = new Date().toISOString();
    const [updated] = await withTenantTx(async (tx) => tx
      .update(schema.message)
      .set({
        readBy: sql`coalesce(${schema.message.readBy}, '{}'::jsonb) || ${JSON.stringify({ [orgId]: now })}::jsonb`,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(
        // Participant + isActive (+ id) predicate comes from the SHARED
        // `buildMessageConditions` (via buildConditions) — the single source of
        // truth for message visibility. The hand-rolled `or(orgId,recipientOrgId,'*')`
        // this replaced diverged from the shared builder's system-org "sees all"
        // carve-out, so the system org could READ a cross-org message but got 0
        // rows here (404 on markAsRead / wrong unread count). Routing through the
        // builder keeps read + write visibility identical. `isActive:true` blocks
        // stamping readBy on a soft-deleted row, matching markThreadAsRead/getUnreadCount.
        // `viewerUserId` scopes per-user targeted rows to their target — a member
        // can't mark-read a message addressed to a different user in their org.
        ...this.buildConditions({ id, isActive: true, viewerUserId: userId } as Partial<MessageFilter>, orgId),
        sql`not (coalesce(${schema.message.readBy}, '{}'::jsonb) ? ${orgId})`,
      ))
      .returning());
    // Direct tx bypasses the CrudService onAfter* hooks — invalidate the reader's
    // cached inbox/unread views so the read state isn't stale for the TTL.
    if (updated) {
      await this.invalidateMessageCaches(orgId);
      return updated as Message;
    }

    // No row updated → either already read, OR not found / not visible to this
    // org. Distinguish so re-marking an already-read message is IDEMPOTENT
    // (returns the message → 200) rather than a spurious 404 on retry.
    const [existing] = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.message)
      .where(and(
        // Same shared participant+isActive+id predicate as the update above, so
        // a message not visible to this org reads as not-found and a soft-deleted
        // one stays non-returnable (parity keeps idempotent re-marks correct).
        ...this.buildConditions({ id, isActive: true, viewerUserId: userId } as Partial<MessageFilter>, orgId),
      ))
      .limit(1));
    return (existing as Message) ?? null;
  }

  /**
   * Edit a sent message's CONTENT. AUTHOR-ONLY: the predicate requires both
   * `org_id = <caller org>` (the SENDER side) AND `created_by = <caller user>`,
   * so a recipient (who can READ the row — incl. via the RLS recipient carve-out)
   * can never rewrite it, and neither can a different member of the sender org.
   * Sets `editedAt` (the "edited" marker, distinct from read-receipt `updatedAt`
   * bumps). Returns the updated row, or null when the caller isn't the author /
   * the message is missing or soft-deleted. Bypasses the CrudService onAfter*
   * hooks (direct tx), so it invalidates the caches itself.
   */
  async editContent(id: string, orgId: string, userId: string, content: string): Promise<Message | null> {
    const now = new Date();
    const [updated] = await withTenantTx(async (tx) => tx
      .update(schema.message)
      .set({ content, editedAt: now, updatedBy: userId, updatedAt: now })
      .where(and(
        eq(schema.message.id, id),
        eq(schema.message.orgId, orgId.toLowerCase()), // sender org only
        eq(schema.message.createdBy, userId), // author only
        eq(schema.message.isActive, true), // not soft-deleted
      ))
      .returning());
    if (updated) {
      const row = updated as Message;
      await this.invalidateMessageCaches(row.orgId, row.recipientOrgId);
      return row;
    }
    return null;
  }

  /**
   * Mark all unread messages in a thread as read for the given org.
   * Stamps `readBy[orgId]` on every active message in the thread that the
   * caller hasn't already read. Cross-participant: a sender marking the
   * thread read does not flip the recipient's read state.
   *
   * @param threadId - Root message ID of the thread
   * @param orgId - Organization ID — scopes access AND identifies the reader
   * @param userId - User performing the action (for updatedBy)
   * @returns Array of updated messages
   */
  async markThreadAsRead(threadId: string, orgId: string, userId: string): Promise<Message[]> {
    const now = new Date().toISOString();
    const updated = await withTenantTx(async (tx) => tx
      .update(schema.message)
      .set({
        readBy: sql`coalesce(${schema.message.readBy}, '{}'::jsonb) || ${JSON.stringify({ [orgId]: now })}::jsonb`,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(
        // Shared participant + isActive predicate (system org "sees all"),
        // scoped to the thread. Replaces the divergent hand-rolled
        // or(orgId,recipientOrgId,'*') so the system support org can mark a
        // cross-org thread read rather than silently matching zero rows.
        // `viewerUserId` keeps per-user targeted rows scoped to their target.
        ...this.buildConditions({ threadId, isActive: true, viewerUserId: userId } as Partial<MessageFilter>, orgId),
        sql`not (coalesce(${schema.message.readBy}, '{}'::jsonb) ? ${orgId})`,
      ))
      .returning());
    if (updated.length > 0) await this.invalidateMessageCaches(orgId);
    return updated as Message[];
  }

  /**
   * Get count of unread messages for an org. Counts messages where the org
   * is a participant (sender or recipient) AND has not yet stamped
   * `readBy[orgId]`. Per-participant — the same thread read by the sender
   * but not the recipient counts as unread for the recipient only.
   *
   * @param orgId - Organization ID for access control + reader identity
   * @returns Number of unread active messages
   */
  async getUnreadCount(orgId: string, viewerUserId?: string): Promise<number> {
    const [row] = await withTenantTx(async (tx) => tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.message)
      .where(and(
        // Shared participant + isActive predicate (system org "sees all") — same
        // builder the inbox/read paths use, so the unread count can't diverge from
        // what the org can actually read. coalesce so a NULL readBy (never-read
        // message) is treated as `{}` and counted as unread — matching
        // markAsRead/markThreadAsRead. Without it, `NULL ? orgId` → NULL →
        // `not NULL` → NULL drops genuinely-unread rows. `viewerUserId` keeps the
        // count consistent with the per-user inbox: a message targeted at another
        // member of the org is neither visible nor counted here.
        ...this.buildConditions({ isActive: true, ...(viewerUserId ? { viewerUserId } : {}) } as Partial<MessageFilter>, orgId),
        sql`not (coalesce(${schema.message.readBy}, '{}'::jsonb) ? ${orgId})`,
      )));
    return row?.count ?? 0;
  }

  /**
   * Cascade soft-delete all replies in a thread.
   * Called after deleting a root message to prevent orphaned replies.
   *
   * Tenancy: replies in a thread can have either the original sender's
   * orgId OR the recipient org's orgId (depending on who replied), so we
   * scope the cascade to BOTH `orgId` and `recipientOrgId` matching the
   * caller's org. Without this filter, a UUID collision (or a buggy
   * client passing an arbitrary threadId) could cascade across tenants.
   *
   * Sysadmins pass `allOrgs=true` to drop the tenant scope so the cascade
   * sweeps replies authored by either participant — without it, the
   * recipient-side replies survive when sysadmin deletes a system-owned root.
   *
   * @param threadId - Root message ID whose replies should be soft-deleted
   * @param userId - User performing the deletion (for audit)
   * @param orgId - The caller's org — scopes the cascade to that tenant
   * @param allOrgs - When true, skip the org-scope filter (sysadmin only)
   */
  async deleteThread(threadId: string, userId: string, orgId: string, allOrgs = false): Promise<void> {
    const now = new Date();
    await withTenantTx(async (tx) => tx
      .update(schema.message)
      .set({
        isActive: false,
        updatedAt: now,
        updatedBy: userId,
        deletedAt: now,
        deletedBy: userId,
        // Stamp the purge deadline so these cascade tombstones are collected by
        // the retention sweep (the base delete does this; this hand-rolled path
        // must too, else purge_after stays NULL and the rows are immortal).
        ...this.purgeAfterStamp(now),
      })
      .where(
        and(
          eq(schema.message.threadId, threadId),
          eq(schema.message.isActive, true),
          allOrgs ? undefined : or(
            eq(schema.message.orgId, orgId),
            eq(schema.message.recipientOrgId, orgId),
          ),
        ),
      ));
    // Direct tx bypasses the onAfter* hooks — invalidate the caller's cached
    // inbox/conversation views (the preceding root-message delete already
    // invalidated both participants via CrudService.delete's hook).
    await this.invalidateMessageCaches(orgId);
  }

  /**
   * Sysadmin moderation: soft-delete ANY message by id, regardless of which org
   * authored it. Mirrors `deleteThread(allOrgs=true)`: the base `delete` pins the
   * mutation to the caller's org, so a message a member org sent to the system org
   * was un-deletable by a sysadmin (404) even though the reply-cascade already
   * sweeps cross-org. This lets a sysadmin remove any conversation root/reply.
   *
   * Returns the row so the caller can cascade + audit; the `isActive = true` guard
   * makes a re-delete return null (→ 404), matching `CrudService.delete`. The route
   * restricts this to sysadmins.
   */
  async deleteAsSysadmin(id: string, userId: string): Promise<Message | null> {
    const now = new Date();
    const [deleted] = await withTenantTx(async (tx) => tx
      .update(schema.message)
      .set({
        isActive: false,
        updatedAt: now,
        updatedBy: userId || 'system',
        deletedAt: now,
        deletedBy: userId || 'system',
        // Stamp the purge deadline so sysadmin-moderated tombstones are collected
        // by the retention sweep (parity with the base delete).
        ...this.purgeAfterStamp(now),
      })
      .where(and(
        eq(schema.message.id, id),
        eq(schema.message.isActive, true),
      ))
      .returning());
    if (deleted) {
      // Reuse the delete hook so BOTH participants' cached inbox/conversation
      // views are invalidated (the actual message's sender + recipient orgs, not
      // the sysadmin's own org). Best-effort — a cache miss must not fail the delete.
      try { await this.onAfterDelete(id, deleted); } catch { /* best-effort cache invalidation */ }
    }
    return deleted ?? null;
  }
}

export const messageService = new MessageService();

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { CrudService, schema, withTenantTx, buildMessageConditions, currentViewerUserId, withViewerContext, type CrudTx, type MessageFilter, type PaginatedResult, type QueryOptions } from '@pipeline-builder/pipeline-data';
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

  /**
   * Every read and write funnels through here, so this is the ONE place the
   * viewer has to be stamped for per-user targeting to resolve. It replaces the
   * viewer arguments that used to be hand-threaded through `findVisibleById` /
   * `findThreadMessages` / `findInboxPaginated` / `getUnreadCount` — a scheme
   * that failed open at whichever call site forgot the argument (and two did:
   * the post-mark-read unread counts in update-message.ts counted rows targeted
   * at OTHER users in the org). See `withViewerContext`.
   */
  protected buildConditions(filter: Partial<MessageFilter>, orgId: string): SQL[] {
    return buildMessageConditions(withViewerContext(filter), orgId);
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
   * Storage keys of attachments whose metadata rows were deleted inside a purge
   * transaction, keyed by message id, awaiting blob deletion in
   * {@link onAfterPurge}. Keys are only ever ADDED here and only REMOVED when
   * `onAfterPurge` consumes them after a commit: a rolled-back attempt leaves its
   * keys behind, but they belong to that same message's attachments, so they are
   * consumed (and correctly deleted) when that message is eventually purged —
   * never used for anything else. Additive (a Set, not overwrite) so a
   * concurrent purge of the same id whose DELETE matched nothing cannot erase
   * the committed attempt's keys before they are consumed.
   */
  private readonly purgedBlobKeys = new Map<string, Set<string>>();

  /**
   * Cascade attachment teardown when messages are HARD-purged (retention sweep
   * or manual purge). Runs inside the purge transaction (sysadmin-scoped for the
   * sweep): deletes the attachment metadata rows for the doomed messages and
   * stashes their storage keys. The blobs are NOT touched here.
   *
   * ORDERING — rows first, blobs after commit. Deleting blobs inside this hook
   * (the old behavior) destroyed them BEFORE the transaction committed: if the
   * parent DELETE or the commit then failed, the rollback resurrected the
   * message + attachment rows pointing at blobs that no longer exist — an
   * unrecoverable, user-visible loss (e.g. a tombstone later restored with
   * broken attachments). With rows first, the worst case is the reverse: a blob
   * whose delete keeps failing outlives its row — a storage leak that is
   * retried, logged, and counted (`message_attachment_blob_orphans_total`),
   * never a dangling reference. The alternative ("delete rows only for blobs
   * that deleted") still deletes blobs before an uncommitted transaction, so it
   * does not close the rollback hole.
   */
  protected async onBeforePurge(ids: string[], tx: CrudTx): Promise<void> {
    if (ids.length === 0) return;
    const removed = await tx
      .delete(schema.messageAttachment)
      .where(inArray(schema.messageAttachment.messageId, ids))
      .returning({ messageId: schema.messageAttachment.messageId, storageKey: schema.messageAttachment.storageKey });
    for (const { messageId, storageKey } of removed as Array<{ messageId: string | null; storageKey: string }>) {
      if (!messageId) continue;
      const keys = this.purgedBlobKeys.get(messageId) ?? new Set<string>();
      keys.add(storageKey);
      this.purgedBlobKeys.set(messageId, keys);
    }
  }

  /**
   * Post-commit blob reclamation for the rows `onBeforePurge` deleted. Only
   * reached once the purge transaction committed (the base class skips it on a
   * rollback). `deleteAttachments` batches to the S3 1000-key cap, honours
   * per-key `Errors`, retries, and never throws.
   */
  protected async onAfterPurge(ids: string[]): Promise<void> {
    const keys: string[] = [];
    for (const id of ids) {
      const stashed = this.purgedBlobKeys.get(id);
      if (!stashed) continue;
      this.purgedBlobKeys.delete(id);
      keys.push(...stashed);
    }
    await deleteAttachments(keys);
  }

  /**
   * Get all reply messages in a thread (excludes the root message).
   *
   * The viewer is stamped by `buildConditions`, so a reply targeted at one user
   * is not returned to their colleagues.
   *
   * @param threadId - ID of the root message
   * @param orgId - Organization ID for access control
   * @returns Array of reply messages in the thread
   */
  async findThreadMessages(threadId: string, orgId: string): Promise<Message[]> {
    return this.find({ threadId, isActive: true } as Partial<MessageFilter>, orgId);
  }

  /**
   * Get a single visible message by id. Mirrors `findById` but pins
   * `isActive: true`, so a soft-deleted row is never returned. The per-user
   * visibility scope now comes from `buildConditions` like every other path —
   * a message targeted at one user reaches only its target (plus the sender org
   * and the system org). Returns null when not visible / not found / inactive.
   */
  async findVisibleById(id: string, orgId: string): Promise<Message | null> {
    const [message] = await this.find({ id, isActive: true } as Partial<MessageFilter>, orgId);
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
    search?: string,
  ): Promise<PaginatedResult<Message>> {
    const filter: Partial<MessageFilter> = {
      isActive: true,
      threadId: null, // SQL-level IS NULL — root messages only
      messageType,
      ...(search ? { search } : {}),
    };
    return this.findPaginated(filter, orgId, options);
  }

  /**
   * Per-page cache key so distinct pages/sorts don't collide or over-cache.
   *
   * The viewer segment is LOAD-BEARING: per-user targeted conversations make a
   * page viewer-specific, so without it user A's cached page (which may include
   * a message targeted only at A) would be served to user B in the same org.
   * Announcements are org-wide (never user-targeted), so their key leaves the
   * segment empty and stays shared per-org.
   *
   * It reads `currentViewerUserId()` — the SAME tenant-context source
   * `buildConditions` stamps the predicate from — precisely so the key and the
   * query can never disagree about who is asking. Deriving the key from a
   * separately-passed argument is what would make that divergence possible, and
   * a divergence here is a cross-user read, not just a stale page.
   */
  private inboxCacheKey(orgId: string, view: 'announcements' | 'conversations', o: QueryOptions, search?: string): string {
    const viewer = view === 'conversations' ? currentViewerUserId() ?? '' : '';
    // `search` is the LAST segment so a term containing ':' can't alias another
    // key; an absent term collapses to the empty segment (the unfiltered page).
    return `${orgId}:${view}:${viewer}:${o.limit ?? ''}:${o.offset ?? ''}:${o.sortBy ?? ''}:${o.sortOrder ?? ''}:${search ?? ''}`;
  }

  /**
   * Get announcements visible to an org (paginated + hard-capped, per-page cached).
   *
   * @param orgId - Organization ID for access control
   * @param options - Pagination + sort options
   * @param search - Optional free-text term over subject/content (same filter
   *   the `/` inbox applies), folded into the cache key.
   * @returns Paginated page of announcement root messages
   */
  async findAnnouncements(orgId: string, options: QueryOptions = {}, search?: string): Promise<PaginatedResult<Message>> {
    return messageCache.getOrSet(
      this.inboxCacheKey(orgId, 'announcements', options, search),
      () => this.findInboxPaginated(orgId, 'announcement', options, search),
    );
  }

  /**
   * Get conversations for an org (paginated + hard-capped, per-page cached).
   *
   * @param orgId - Organization ID for access control
   * @param options - Pagination + sort options
   * @param search - Optional free-text term over subject/content (same filter
   *   the `/` inbox applies), folded into the cache key.
   * @returns Paginated page of conversation root messages
   */
  async findConversations(orgId: string, options: QueryOptions = {}, search?: string): Promise<PaginatedResult<Message>> {
    return messageCache.getOrSet(
      this.inboxCacheKey(orgId, 'conversations', options, search),
      () => this.findInboxPaginated(orgId, 'conversation', options, search),
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
        // The stamped viewer scopes per-user targeted rows to their target — a
        // member can't mark-read a message addressed to a different user.
        ...this.buildConditions({ id, isActive: true } as Partial<MessageFilter>, orgId),
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
        // Same shared participant+isActive+id predicate as the update above (the
        // viewer included, via the stamp), so a message not visible to this org
        // or user reads as not-found and a soft-deleted one stays non-returnable
        // — parity keeps idempotent re-marks correct.
        ...this.buildConditions({ id, isActive: true } as Partial<MessageFilter>, orgId),
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
        // The stamped viewer keeps per-user targeted rows scoped to their target.
        ...this.buildConditions({ threadId, isActive: true } as Partial<MessageFilter>, orgId),
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
  async getUnreadCount(orgId: string): Promise<number> {
    const [row] = await withTenantTx(async (tx) => tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.message)
      .where(and(
        // Shared participant + isActive predicate (system org "sees all") — same
        // builder the inbox/read paths use, so the unread count can't diverge from
        // what the org can actually read. coalesce so a NULL readBy (never-read
        // message) is treated as `{}` and counted as unread — matching
        // markAsRead/markThreadAsRead. Without it, `NULL ? orgId` → NULL →
        // `not NULL` → NULL drops genuinely-unread rows. The stamped viewer keeps the
        // count consistent with the per-user inbox: a message targeted at another
        // member of the org is neither visible nor counted here.
        ...this.buildConditions({ isActive: true } as Partial<MessageFilter>, orgId),
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

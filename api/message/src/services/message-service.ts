// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService } from '@pipeline-builder/api-core';
import { CoreConstants, CrudService, schema, withTenantTx, buildMessageConditions, type MessageFilter } from '@pipeline-builder/pipeline-core';
import { SQL, eq, and, or, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

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
    if (recipientOrgId === '*') patterns.add('*:announcements');
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
   * Get all reply messages in a thread (excludes the root message).
   *
   * @param threadId - ID of the root message
   * @param orgId - Organization ID for access control
   * @returns Array of reply messages in the thread
   */
  async findThreadMessages(threadId: string, orgId: string): Promise<Message[]> {
    return this.find(
      { threadId, isActive: true } as Partial<MessageFilter>,
      orgId,
    );
  }

  /**
   * Get inbox: root messages (threadId is null) where org is sender or recipient.
   *
   * Announcements (recipientOrgId='*') are surfaced to every org and are
   * counted in the unified inbox total — we intentionally do NOT split inbox
   * vs broadcasts because the UI treats them as a single feed; consumers that
   * need a typed view filter with `messageType`.
   *
   * @param orgId - Organization ID for access control
   * @param messageType - Optional filter for announcement or conversation
   * @returns Array of root messages sorted by most recent
   */
  async findInbox(orgId: string, messageType?: 'announcement' | 'conversation'): Promise<Message[]> {
    const filter: Partial<MessageFilter> = {
      isActive: true,
      threadId: null, // SQL-level IS NULL — root messages only
      ...(messageType ? { messageType } : {}),
    };
    return this.find(filter, orgId);
  }

  /**
   * Get announcements visible to an org.
   *
   * @param orgId - Organization ID for access control
   * @returns Array of announcement root messages
   */
  async findAnnouncements(orgId: string): Promise<Message[]> {
    return messageCache.getOrSet(`${orgId}:announcements`, () => this.findInbox(orgId, 'announcement'));
  }

  /**
   * Get conversations for an org.
   *
   * @param orgId - Organization ID for access control
   * @returns Array of conversation root messages
   */
  async findConversations(orgId: string): Promise<Message[]> {
    return messageCache.getOrSet(`${orgId}:conversations`, () => this.findInbox(orgId, 'conversation'));
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
        eq(schema.message.id, id),
        sql`not (coalesce(${schema.message.readBy}, '{}'::jsonb) ? ${orgId})`,
        or(
          eq(schema.message.orgId, orgId),
          eq(schema.message.recipientOrgId, orgId),
          eq(schema.message.recipientOrgId, '*'),
        ),
      ))
      .returning());
    // Direct tx bypasses the CrudService onAfter* hooks — invalidate the reader's
    // cached inbox/unread views so the read state isn't stale for the TTL.
    if (updated) await this.invalidateMessageCaches(orgId);
    return (updated as Message) ?? null;
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
        eq(schema.message.threadId, threadId),
        eq(schema.message.isActive, true),
        sql`not (coalesce(${schema.message.readBy}, '{}'::jsonb) ? ${orgId})`,
        or(
          eq(schema.message.orgId, orgId),
          eq(schema.message.recipientOrgId, orgId),
          eq(schema.message.recipientOrgId, '*'),
        ),
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
        eq(schema.message.isActive, true),
        sql`not (${schema.message.readBy} ? ${orgId})`,
        or(
          eq(schema.message.orgId, orgId),
          eq(schema.message.recipientOrgId, orgId),
          eq(schema.message.recipientOrgId, '*'),
        ),
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
    await withTenantTx(async (tx) => tx
      .update(schema.message)
      .set({
        isActive: false,
        updatedAt: new Date(),
        updatedBy: userId,
        deletedAt: new Date(),
        deletedBy: userId,
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
}

export const messageService = new MessageService();

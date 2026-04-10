// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createCacheService, createLogger, errorMessage } from '@mwashburn160/api-core';
import { CoreConstants, CrudService, schema, db, buildMessageConditions, type MessageFilter } from '@mwashburn160/pipeline-core';
import { SQL, eq, and } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

type Message = typeof schema.message.$inferSelect;
type MessageInsert = typeof schema.message.$inferInsert;
type MessageUpdate = Partial<Omit<MessageInsert, 'id' | 'createdAt' | 'createdBy'>>;

const logger = createLogger('message-service');

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
      isRead: schema.message.isRead,
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

  protected async onAfterCreate(entity: Message): Promise<void> {
    messageCache.invalidatePattern(`${entity.orgId}:*`).catch((err) => {
      logger.debug('Cache invalidation failed after message create', { orgId: entity.orgId, error: errorMessage(err) });
    });
  }

  protected async onAfterUpdate(_id: string, entity: Message): Promise<void> {
    messageCache.invalidatePattern(`${entity.orgId}:*`).catch((err) => {
      logger.debug('Cache invalidation failed after message update', { orgId: entity.orgId, error: errorMessage(err) });
    });
  }

  protected async onAfterDelete(_id: string, entity: Message): Promise<void> {
    messageCache.invalidatePattern(`${entity.orgId}:*`).catch((err) => {
      logger.debug('Cache invalidation failed after message delete', { orgId: entity.orgId, error: errorMessage(err) });
    });
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
   * Mark a single message as read.
   *
   * @param id - Message ID
   * @param orgId - Organization ID for access control
   * @param userId - User performing the action (for updatedBy)
   * @returns Updated message, or null if not found
   */
  async markAsRead(id: string, orgId: string, userId: string): Promise<Message | null> {
    return this.update(id, { isRead: true } as Partial<MessageUpdate>, orgId, userId);
  }

  /**
   * Mark all unread messages in a thread as read for the given org.
   *
   * @param threadId - Root message ID of the thread
   * @param orgId - Organization ID for access control
   * @param userId - User performing the action (for updatedBy)
   * @returns Array of updated messages
   */
  async markThreadAsRead(threadId: string, orgId: string, userId: string): Promise<Message[]> {
    return this.updateMany(
      { threadId, isRead: false } as Partial<MessageFilter>,
      { isRead: true } as Partial<MessageUpdate>,
      orgId,
      userId,
    );
  }

  /**
   * Get count of unread messages for an org.
   *
   * @param orgId - Organization ID for access control
   * @returns Number of unread active messages
   */
  async getUnreadCount(orgId: string): Promise<number> {
    const filter: Partial<MessageFilter> = {
      isActive: true,
      isRead: false,
    };
    return this.count(filter, orgId);
  }

  /**
   * Cascade soft-delete all replies in a thread.
   * Called after deleting a root message to prevent orphaned replies.
   *
   * @param threadId - Root message ID whose replies should be soft-deleted
   * @param userId - User performing the deletion (for audit)
   */
  async deleteThread(threadId: string, userId: string): Promise<void> {
    await db
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
        ),
      );
  }
}

export const messageService = new MessageService();

import { CrudService, schema, buildMessageConditions, type MessageFilter } from '@mwashburn160/pipeline-core';
import { SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

type Message = typeof schema.message.$inferSelect;
type MessageInsert = typeof schema.message.$inferInsert;
type MessageUpdate = Partial<Omit<MessageInsert, 'id' | 'createdAt' | 'createdBy'>>;

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

  /**
   * Get all messages in a thread (including the root message)
   */
  async findThreadMessages(threadId: string, orgId: string): Promise<Message[]> {
    return this.find(
      { threadId, isActive: true } as Partial<MessageFilter>,
      orgId,
    );
  }

  /**
   * Get inbox: root messages (threadId is null) where org is sender or recipient.
   * Returns only root messages sorted by most recent.
   */
  async findInbox(orgId: string, messageType?: 'announcement' | 'conversation'): Promise<Message[]> {
    const filter: Partial<MessageFilter> = {
      isActive: true,
      ...(messageType ? { messageType } : {}),
    };
    // Find all matching messages, then filter to root messages (threadId is null)
    const messages = await this.find(filter, orgId);
    return messages.filter(m => m.threadId === null);
  }

  /**
   * Get announcements visible to an org
   */
  async findAnnouncements(orgId: string): Promise<Message[]> {
    return this.findInbox(orgId, 'announcement');
  }

  /**
   * Get conversations for an org
   */
  async findConversations(orgId: string): Promise<Message[]> {
    return this.findInbox(orgId, 'conversation');
  }

  /**
   * Mark a single message as read
   */
  async markAsRead(id: string, orgId: string, userId: string): Promise<Message | null> {
    return this.update(id, { isRead: true } as Partial<MessageUpdate>, orgId, userId);
  }

  /**
   * Mark all messages in a thread as read for the given org
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
   * Get count of unread messages for an org
   */
  async getUnreadCount(orgId: string): Promise<number> {
    const filter: Partial<MessageFilter> = {
      isActive: true,
      isRead: false,
    };
    return this.count(filter, orgId);
  }
}

export const messageService = new MessageService();

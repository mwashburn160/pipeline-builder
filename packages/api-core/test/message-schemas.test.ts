import {
  MessageTypeSchema,
  MessagePrioritySchema,
  MessageFilterSchema,
  MessageCreateSchema,
  MessageReplySchema,
} from '../src/validation/message-schemas';

describe('MessageTypeSchema', () => {
  it('should accept "announcement"', () => {
    expect(MessageTypeSchema.parse('announcement')).toBe('announcement');
  });

  it('should accept "conversation"', () => {
    expect(MessageTypeSchema.parse('conversation')).toBe('conversation');
  });

  it('should reject invalid values', () => {
    expect(() => MessageTypeSchema.parse('dm')).toThrow();
    expect(() => MessageTypeSchema.parse('')).toThrow();
  });
});

describe('MessagePrioritySchema', () => {
  it('should accept valid priorities', () => {
    expect(MessagePrioritySchema.parse('normal')).toBe('normal');
    expect(MessagePrioritySchema.parse('high')).toBe('high');
    expect(MessagePrioritySchema.parse('urgent')).toBe('urgent');
  });

  it('should reject invalid values', () => {
    expect(() => MessagePrioritySchema.parse('low')).toThrow();
    expect(() => MessagePrioritySchema.parse('critical')).toThrow();
  });
});

describe('MessageFilterSchema', () => {
  it('should parse valid filter with all fields', () => {
    const result = MessageFilterSchema.parse({
      threadId: '550e8400-e29b-41d4-a716-446655440000',
      recipientOrgId: 'org-123',
      messageType: 'announcement',
      isRead: 'true',
      priority: 'high',
    });
    expect(result.threadId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.recipientOrgId).toBe('org-123');
    expect(result.messageType).toBe('announcement');
    expect(result.isRead).toBe(true);
    expect(result.priority).toBe('high');
  });

  it('should allow all fields to be optional', () => {
    const result = MessageFilterSchema.parse({});
    expect(result.threadId).toBeUndefined();
    expect(result.recipientOrgId).toBeUndefined();
    expect(result.messageType).toBeUndefined();
  });

  it('should reject invalid threadId (not UUID)', () => {
    expect(() => MessageFilterSchema.parse({ threadId: 'not-a-uuid' })).toThrow();
  });

  it('should reject empty recipientOrgId', () => {
    expect(() => MessageFilterSchema.parse({ recipientOrgId: '' })).toThrow();
  });

  it('should inherit base filter fields', () => {
    const result = MessageFilterSchema.parse({
      accessModifier: 'public',
      isActive: true,
    });
    expect(result.accessModifier).toBe('public');
    expect(result.isActive).toBe(true);
  });
});

describe('MessageCreateSchema', () => {
  it('should parse valid creation body', () => {
    const result = MessageCreateSchema.parse({
      recipientOrgId: 'org-456',
      subject: 'Hello',
      content: 'World',
    });
    expect(result.recipientOrgId).toBe('org-456');
    expect(result.subject).toBe('Hello');
    expect(result.content).toBe('World');
    expect(result.messageType).toBe('conversation'); // default
    expect(result.priority).toBe('normal'); // default
  });

  it('should accept optional fields', () => {
    const result = MessageCreateSchema.parse({
      recipientOrgId: 'org-456',
      subject: 'Urgent notice',
      content: 'Please read',
      messageType: 'announcement',
      priority: 'urgent',
    });
    expect(result.messageType).toBe('announcement');
    expect(result.priority).toBe('urgent');
  });

  it('should reject missing required fields', () => {
    expect(() => MessageCreateSchema.parse({})).toThrow();
    expect(() => MessageCreateSchema.parse({ recipientOrgId: 'org', subject: 'Hi' })).toThrow();
    expect(() => MessageCreateSchema.parse({ recipientOrgId: 'org', content: 'text' })).toThrow();
  });

  it('should reject empty strings for required fields', () => {
    expect(() => MessageCreateSchema.parse({
      recipientOrgId: '',
      subject: 'Hi',
      content: 'text',
    })).toThrow();

    expect(() => MessageCreateSchema.parse({
      recipientOrgId: 'org',
      subject: '',
      content: 'text',
    })).toThrow();

    expect(() => MessageCreateSchema.parse({
      recipientOrgId: 'org',
      subject: 'Hi',
      content: '',
    })).toThrow();
  });
});

describe('MessageReplySchema', () => {
  it('should parse valid reply', () => {
    const result = MessageReplySchema.parse({ content: 'Thanks!' });
    expect(result.content).toBe('Thanks!');
  });

  it('should reject empty content', () => {
    expect(() => MessageReplySchema.parse({ content: '' })).toThrow();
  });

  it('should reject missing content', () => {
    expect(() => MessageReplySchema.parse({})).toThrow();
  });
});

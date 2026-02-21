import { withUpdateTimestamp, forCreation, forSoftDelete } from '../src/database/helpers';
import type { EntityWithTimestamps } from '../src/database/helpers';

// Extend the base types for testing
interface TestEntity extends EntityWithTimestamps {
  name?: string;
  description?: string;
}

describe('withUpdateTimestamp', () => {
  it('should add updatedBy and updatedAt fields', () => {
    const result = withUpdateTimestamp<TestEntity>({ name: 'new-name' }, 'user-123');
    expect(result.name).toBe('new-name');
    expect(result.updatedBy).toBe('user-123');
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('should preserve existing fields', () => {
    const result = withUpdateTimestamp<TestEntity>(
      { name: 'test', description: 'desc' },
      'admin',
    );
    expect(result.name).toBe('test');
    expect(result.description).toBe('desc');
    expect(result.updatedBy).toBe('admin');
  });

  it('should override existing updatedBy and updatedAt', () => {
    const oldDate = new Date('2020-01-01');
    const result = withUpdateTimestamp<TestEntity>(
      { updatedBy: 'old-user', updatedAt: oldDate },
      'new-user',
    );
    expect(result.updatedBy).toBe('new-user');
    expect(result.updatedAt).not.toEqual(oldDate);
  });
});

describe('forCreation', () => {
  it('should add updatedAt timestamp', () => {
    const result = forCreation<TestEntity>({ name: 'plugin' } as any);
    expect(result.updatedAt).toBeInstanceOf(Date);
    expect((result as any).name).toBe('plugin');
  });

  it('should preserve all original data', () => {
    const data = { name: 'test', createdBy: 'user-1' } as any;
    const result = forCreation<TestEntity>(data);
    expect((result as any).name).toBe('test');
  });
});

describe('forSoftDelete', () => {
  it('should return soft delete fields', () => {
    const result = forSoftDelete('user-123');
    expect(result.deletedAt).toBeInstanceOf(Date);
    expect(result.deletedBy).toBe('user-123');
    expect(result.isActive).toBe(false);
  });

  it('should have isActive set to false', () => {
    const result = forSoftDelete('admin');
    expect(result.isActive).toBe(false);
  });
});

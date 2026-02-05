/**
 * Generic database helper functions for common entity operations.
 * These helpers reduce code duplication across different entity types.
 */

/**
 * Base interface for entities with timestamp fields
 */
export interface EntityWithTimestamps {
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly createdBy?: string;
  readonly updatedBy?: string;
}

/**
 * Base interface for entities with soft delete support
 */
export interface EntityWithSoftDelete {
  readonly deletedAt?: Date | null;
  readonly deletedBy?: string | null;
  readonly isActive?: boolean;
}

/**
 * Generic helper to add update timestamp fields to an entity update.
 *
 * @template T - The entity update type
 * @param updates - Partial entity data to update
 * @param updatedBy - Username/ID of the user performing the update
 * @returns Updated object with timestamp fields
 *
 * @example
 * const pluginUpdate = withUpdateTimestamp({ name: 'new-name' }, 'user-123');
 * // Returns: { name: 'new-name', updatedBy: 'user-123', updatedAt: Date }
 */
export function withUpdateTimestamp<T extends EntityWithTimestamps>(
  updates: Partial<T>,
  updatedBy: string,
): Partial<T> {
  return {
    ...updates,
    updatedBy,
    updatedAt: new Date(),
  } as Partial<T>;
}

/**
 * Generic helper to prepare data for entity creation with timestamps.
 * Sets both creation and update timestamps.
 *
 * @template T - The entity insert type
 * @param data - Entity data without timestamps
 * @returns Data with creation timestamp (updatedAt is set by default in schema)
 *
 * @example
 * const newPlugin = forCreation({ name: 'my-plugin', version: '1.0.0' });
 * // Returns original data (createdAt/updatedAt set by DB defaults)
 */
export function forCreation<T extends EntityWithTimestamps>(
  data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>,
): Omit<T, 'id' | 'createdAt'> {
  return {
    ...data,
    updatedAt: new Date(),
  } as Omit<T, 'id' | 'createdAt'>;
}

/**
 * Generic helper to create a soft delete update object.
 * Marks an entity as deleted without removing it from the database.
 *
 * @template T - The entity update type
 * @param deletedBy - Username/ID of the user performing the deletion
 * @returns Update object with soft delete fields
 *
 * @example
 * const deleteUpdate = forSoftDelete('user-123');
 * // Returns: { deletedAt: Date, deletedBy: 'user-123', isActive: false }
 */
export function forSoftDelete<T extends EntityWithSoftDelete>(
  deletedBy: string,
): Partial<T> {
  return {
    deletedAt: new Date(),
    deletedBy,
    isActive: false,
  } as Partial<T>;
}

/**
 * Generic helper to create a restore (un-delete) update object.
 * Restores a soft-deleted entity.
 *
 * @template T - The entity update type
 * @param updatedBy - Username/ID of the user performing the restore
 * @returns Update object to restore the entity
 *
 * @example
 * const restoreUpdate = forRestore('user-123');
 * // Returns: { deletedAt: null, deletedBy: null, isActive: true, updatedBy: 'user-123', updatedAt: Date }
 */
export function forRestore<T extends EntityWithSoftDelete & EntityWithTimestamps>(
  updatedBy: string,
): Partial<T> {
  return {
    deletedAt: null,
    deletedBy: null,
    isActive: true,
    updatedBy,
    updatedAt: new Date(),
  } as Partial<T>;
}

import { entityEvents } from '@mwashburn160/api-core';

/**
 * Lightweight user service for emitting entity lifecycle events.
 *
 * This does NOT replace the user controller/routes — those remain as-is.
 * Called FROM controllers after successful mutations to notify compliance
 * and other subscribers.
 */
class UserService {
  /**
   * Emit event after user profile update.
   */
  notifyUpdated(userId: string, orgId: string, changes: Record<string, unknown>): void {
    entityEvents.emit({
      eventType: 'updated',
      target: 'user',
      entityId: userId,
      orgId,
      userId,
      timestamp: new Date(),
      attributes: changes,
    });
  }

  /**
   * Emit event after user deletion.
   */
  notifyDeleted(userId: string, orgId: string): void {
    entityEvents.emit({
      eventType: 'deleted',
      target: 'user',
      entityId: userId,
      orgId,
      userId,
      timestamp: new Date(),
      attributes: {},
    });
  }
}

export const userService = new UserService();

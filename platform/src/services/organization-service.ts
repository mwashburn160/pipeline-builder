import { entityEvents } from '@mwashburn160/api-core';

/**
 * Lightweight organization service for emitting entity lifecycle events.
 *
 * This does NOT replace the organization controller/routes — those remain as-is
 * with their complex transaction/populate logic. This service is called FROM
 * controllers after successful mutations to notify compliance and other subscribers.
 */
class OrganizationService {
  /**
   * Emit event after org creation.
   */
  notifyCreated(orgId: string, orgName: string, userId: string): void {
    entityEvents.emit({
      eventType: 'created',
      target: 'organization',
      entityId: orgId,
      orgId,
      userId,
      timestamp: new Date(),
      attributes: { name: orgName },
    });
  }

  /**
   * Emit event after org update.
   */
  notifyUpdated(orgId: string, changes: Record<string, unknown>, userId: string): void {
    entityEvents.emit({
      eventType: 'updated',
      target: 'organization',
      entityId: orgId,
      orgId,
      userId,
      timestamp: new Date(),
      attributes: changes,
    });
  }

  /**
   * Emit event after org deletion.
   */
  notifyDeleted(orgId: string, userId: string): void {
    entityEvents.emit({
      eventType: 'deleted',
      target: 'organization',
      entityId: orgId,
      orgId,
      userId,
      timestamp: new Date(),
      attributes: {},
    });
  }
}

export const organizationService = new OrganizationService();

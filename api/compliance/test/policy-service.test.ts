// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Stub the base CrudService so we can test only the subclass-specific methods.
class StubCrudService {
  // Subclasses provide getters/protected methods we don't need at runtime here.
  find = jest.fn();
  findById = jest.fn();
  create = jest.fn();
  update = jest.fn();
  delete = jest.fn();
}

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CrudService: StubCrudService,
  buildCompliancePolicyConditions: jest.fn(() => []),
  buildComplianceRuleConditions: jest.fn(() => []),
  buildPublishedRuleCatalogConditions: jest.fn(() => []),
  drizzleCount: (r: unknown) => r,
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
  // tx supports the chain shape used by policy-service.cloneTemplate
  // (`tx.select().from(...).where(...)`) — returns no template-rules by default.
  withTenantTx: <T>(fn: (tx: unknown) => T): T => fn({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  }),
  // Transitive import (policy-service → compliance-rule-service) reads
  // CoreConstants.CACHE_TTL_COMPLIANCE_RULES at module load. Provide a stub.
  CoreConstants: { CACHE_TTL_COMPLIANCE_RULES: 60_000 },
  // Transitive import chain (policy-service → compliance-rule-service →
  // rule-change-notifier → message-client) builds its client via createServiceClient.
  createServiceClient: () => ({ post: jest.fn(), get: jest.fn() }),
  Config: {
    getAny: (key: string) => key === 'server'
      ? { services: { messageHost: 'localhost', messagePort: 0 } }
      : undefined,
    get: (key: string) => key === 'server'
      ? { services: { messageHost: 'localhost', messagePort: 0 } }
      : undefined,
  },
  schema: {
    compliancePolicy: {
      name: 'col_name',
      createdAt: 'col_createdAt',
      updatedAt: 'col_updatedAt',
      orgId: 'col_orgId',
      version: 'col_version',
    },
    complianceRule: {
      policyId: 'col_policyId',
      isActive: 'col_isActive',
      deletedAt: 'col_deletedAt',
    },
  },
}));

const { CompliancePolicyService } = await import('../src/services/policy-service.js');

describe('CompliancePolicyService', () => {
  let svc: InstanceType<typeof CompliancePolicyService>;

  beforeEach(() => {
    svc = new CompliancePolicyService();
  });

  describe('findTemplates', () => {
    it('calls find with isTemplate=true and "system" org', async () => {
      const findSpy = jest.spyOn(svc, 'find').mockResolvedValue([{ id: 'p1' } as never]);

      const result = await svc.findTemplates();

      expect(findSpy).toHaveBeenCalledWith({ isTemplate: true }, 'system');
      expect(result).toEqual([{ id: 'p1' }]);
    });

    it('returns empty list when no templates exist', async () => {
      jest.spyOn(svc, 'find').mockResolvedValue([]);
      const result = await svc.findTemplates();
      expect(result).toEqual([]);
    });
  });

  describe('cloneTemplate', () => {
    const fakeTemplate = {
      id: 'tpl-1',
      name: 'tpl-name',
      description: 'desc',
      version: '1.0.0',
    };

    it('throws when template not found', async () => {
      jest.spyOn(svc, 'findById').mockResolvedValue(null as never);

      await expect(svc.cloneTemplate('tpl-x', 'org-1', 'user-1'))
        .rejects.toThrow('Template not found');
    });

    it('clones template into target org with isTemplate=false', async () => {
      jest.spyOn(svc, 'findById').mockResolvedValue(fakeTemplate as never);
      const createSpy = jest.spyOn(svc, 'create').mockImplementation(async (data: any) => ({ ...(data as Record<string, unknown>), id: 'new-id' } as never));

      const result = await svc.cloneTemplate('tpl-1', 'org-target', 'user-1');

      expect(svc.findById).toHaveBeenCalledWith('tpl-1', 'system');
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 'org-target',
        name: 'tpl-name',
        description: 'desc',
        version: '1.0.0',
        isTemplate: false,
        createdBy: 'user-1',
        updatedBy: 'user-1',
      }), 'user-1');
      expect((result as { id: string }).id).toBe('new-id');
    });
  });
});

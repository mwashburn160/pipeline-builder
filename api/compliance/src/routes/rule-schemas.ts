// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/** Valid compliance rule operators — single source of truth for Zod validation. */
export const VALID_OPERATORS = [
  'eq', 'neq', 'contains', 'notContains', 'regex',
  'gt', 'gte', 'lt', 'lte', 'in', 'notIn',
  'exists', 'notExists', 'countGt', 'countLt', 'lengthGt', 'lengthLt',
] as const;

export const OperatorEnum = z.enum(VALID_OPERATORS);

export const ConditionSchema = z.object({
  field: z.string().min(1).max(100),
  operator: OperatorEnum,
  value: z.unknown().optional(),
  dependsOnRule: z.string().uuid().optional(),
});

export const ComplianceRuleCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  policyId: z.string().uuid().optional(),
  priority: z.number().int().min(0).max(10000).default(0),
  target: z.enum(['plugin', 'pipeline']),
  severity: z.enum(['warning', 'error', 'critical']).default('error'),
  tags: z.array(z.string()).default([]),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
  scope: z.enum(['org', 'published']).default('org'),
  suppressNotification: z.boolean().default(false),
  field: z.string().max(100).optional(),
  operator: OperatorEnum.optional(),
  value: z.unknown().optional(),
  conditions: z.array(ConditionSchema).optional(),
  conditionMode: z.enum(['all', 'any']).default('all'),
});

export const ComplianceRuleUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  policyId: z.string().uuid().nullable().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  severity: z.enum(['warning', 'error', 'critical']).optional(),
  tags: z.array(z.string()).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveUntil: z.string().datetime().nullable().optional(),
  suppressNotification: z.boolean().optional(),
  field: z.string().max(100).optional(),
  operator: OperatorEnum.optional(),
  value: z.unknown().optional(),
  conditions: z.array(ConditionSchema).optional(),
  conditionMode: z.enum(['all', 'any']).optional(),
  isActive: z.boolean().optional(),
});

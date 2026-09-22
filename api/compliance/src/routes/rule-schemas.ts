// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  RULE_CONDITION_MODES, RULE_OPERATORS, RULE_SCOPES, RULE_SEVERITIES, RULE_TARGETS,
} from '@pipeline-builder/api-core';
import { z } from 'zod';

const OperatorEnum = z.enum(RULE_OPERATORS);

const ConditionSchema = z.object({
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
  target: z.enum(RULE_TARGETS),
  severity: z.enum(RULE_SEVERITIES).default('error'),
  tags: z.array(z.string()).default([]),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
  scope: z.enum(RULE_SCOPES).default('org'),
  suppressNotification: z.boolean().default(false),
  // Org → team hierarchy: also enforce this org's rule on descendant teams.
  propagateToChildren: z.boolean().default(false),
  field: z.string().max(100).optional(),
  operator: OperatorEnum.optional(),
  value: z.unknown().optional(),
  conditions: z.array(ConditionSchema).optional(),
  conditionMode: z.enum(RULE_CONDITION_MODES).default('all'),
});

export const ComplianceRuleUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  policyId: z.string().uuid().nullable().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  severity: z.enum(RULE_SEVERITIES).optional(),
  tags: z.array(z.string()).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveUntil: z.string().datetime().nullable().optional(),
  suppressNotification: z.boolean().optional(),
  propagateToChildren: z.boolean().optional(),
  field: z.string().max(100).optional(),
  operator: OperatorEnum.optional(),
  value: z.unknown().optional(),
  conditions: z.array(ConditionSchema).optional(),
  conditionMode: z.enum(RULE_CONDITION_MODES).optional(),
  isActive: z.boolean().optional(),
});

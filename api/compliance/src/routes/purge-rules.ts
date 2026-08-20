// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { createCompliancePurgeRoutes } from './purge-factory.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

/** `POST /compliance/rules/:id/purge` — see {@link createCompliancePurgeRoutes}. */
export function createPurgeRuleRoutes(): Router {
  return createCompliancePurgeRoutes({
    service: complianceRuleService,
    label: 'Rule',
    action: 'compliance.rule.purge',
    targetType: 'rule',
  });
}

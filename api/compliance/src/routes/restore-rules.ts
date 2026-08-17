// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { createComplianceRestoreRoutes } from './restore-factory.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

/** `POST /compliance/rules/:id/restore` — see {@link createComplianceRestoreRoutes}. */
export function createRestoreRuleRoutes(): Router {
  return createComplianceRestoreRoutes({
    service: complianceRuleService,
    label: 'Rule',
    action: 'compliance.rule.restore',
    targetType: 'rule',
  });
}

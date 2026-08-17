// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { createComplianceRestoreRoutes } from './restore-factory.js';
import { compliancePolicyService } from '../services/policy-service.js';

/** `POST /compliance/policies/:id/restore` — see {@link createComplianceRestoreRoutes}. */
export function createRestorePolicyRoutes(): Router {
  return createComplianceRestoreRoutes({
    service: compliancePolicyService,
    label: 'Policy',
    action: 'compliance.policy.restore',
    targetType: 'policy',
  });
}

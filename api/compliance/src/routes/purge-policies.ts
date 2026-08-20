// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { createCompliancePurgeRoutes } from './purge-factory.js';
import { compliancePolicyService } from '../services/policy-service.js';

/** `POST /compliance/policies/:id/purge` — see {@link createCompliancePurgeRoutes}. */
export function createPurgePolicyRoutes(): Router {
  return createCompliancePurgeRoutes({
    service: compliancePolicyService,
    label: 'Policy',
    action: 'compliance.policy.purge',
    targetType: 'policy',
  });
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerBillingRoutes } from './billing-routes.js';
import { registerMessageRoutes } from './message-routes.js';
import { registerPipelineRoutes } from './pipeline-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { registerQuotaRoutes } from './quota-routes.js';

/**
 * Register all OpenAPI route definitions with the shared registry.
 * Call this once during spec generation initialization.
 */
export function registerAllRoutes(): void {
  registerBillingRoutes();
  registerMessageRoutes();
  registerPipelineRoutes();
  registerPluginRoutes();
  registerQuotaRoutes();
}

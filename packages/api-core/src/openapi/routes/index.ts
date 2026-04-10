// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerBillingRoutes } from './billing-routes';
import { registerMessageRoutes } from './message-routes';
import { registerPipelineRoutes } from './pipeline-routes';
import { registerPluginRoutes } from './plugin-routes';
import { registerQuotaRoutes } from './quota-routes';

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

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerAskRoutes } from './ask-routes.js';
import { registerBillingRoutes } from './billing-routes.js';
import { registerImageRegistryRoutes } from './image-registry-routes.js';
import { registerMessageRoutes } from './message-routes.js';
import { registerPipelineRoutes } from './pipeline-routes.js';
import { registerPipelineTemplateRoutes } from './pipeline-template-routes.js';
import { registerPluginRoutes } from './plugin-routes.js';
import { registerQuotaRoutes } from './quota-routes.js';

/**
 * Register all OpenAPI route definitions with the shared registry.
 * Call this once during spec generation initialization.
 */
export function registerAllRoutes(): void {
  registerAskRoutes();
  registerBillingRoutes();
  registerImageRegistryRoutes();
  registerMessageRoutes();
  registerPipelineRoutes();
  registerPipelineTemplateRoutes();
  registerPluginRoutes();
  registerQuotaRoutes();
  // NOTE: compliance + reporting (large multi-router surfaces) and platform/auth
  // are not yet registered — follow-on, and intentionally omitted rather than
  // shipping inaccurate paths.
}

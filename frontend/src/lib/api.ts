// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ApiCore } from './api/core';
import { authApi } from './api/domains/auth';
import { organizationsApi } from './api/domains/organizations';
import { adminApi } from './api/domains/admin';
import { billingApi } from './api/domains/billing';
import { pluginsApi } from './api/domains/plugins';
import { pipelinesApi } from './api/domains/pipelines';
import { registryApi } from './api/domains/registry';
import { observabilityApi } from './api/domains/observability';
import { messagesApi } from './api/domains/messages';
import { reportingApi } from './api/domains/reporting';
import { complianceApi } from './api/domains/compliance';

const core = new ApiCore();

export const api = Object.assign(
  core,
  authApi(core),
  organizationsApi(core),
  adminApi(core),
  billingApi(core),
  pluginsApi(core),
  pipelinesApi(core),
  registryApi(core),
  observabilityApi(core),
  messagesApi(core),
  reportingApi(core),
  complianceApi(core),
) as ApiCore
  & ReturnType<typeof authApi>
  & ReturnType<typeof organizationsApi>
  & ReturnType<typeof adminApi>
  & ReturnType<typeof billingApi>
  & ReturnType<typeof pluginsApi>
  & ReturnType<typeof pipelinesApi>
  & ReturnType<typeof registryApi>
  & ReturnType<typeof observabilityApi>
  & ReturnType<typeof messagesApi>
  & ReturnType<typeof reportingApi>
  & ReturnType<typeof complianceApi>;

export default api;

export { ApiError, ConflictError, StepUpRequiredError } from './api/errors';
export { base64UrlDecode } from './api/util';
export type { StreamEvent } from './api/core';

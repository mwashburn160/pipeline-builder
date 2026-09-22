// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { InternalHttpClient, serviceEndpoint, type InternalService } from '@pipeline-builder/api-core';

/**
 * Construct an `InternalHttpClient` for a sibling service at its registry
 * address (`<NAME>_SERVICE_HOST` / `<NAME>_SERVICE_PORT`).
 *
 * @example
 *   export const messageClient = createServiceClient('message');
 */
export function createServiceClient(service: InternalService): InternalHttpClient {
  return new InternalHttpClient(serviceEndpoint(service));
}

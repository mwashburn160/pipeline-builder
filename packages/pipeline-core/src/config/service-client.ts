// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { InternalHttpClient } from '@pipeline-builder/api-core';
import { Config } from './app-config.js';

/** Sibling services reachable over the internal network, keyed by the typed
 *  `server.services.<name>Host`/`<name>Port` config entries. */
export type InternalService = 'plugin' | 'pipeline' | 'message' | 'platform' | 'compliance' | 'billing';

/**
 * Construct an `InternalHttpClient` for a sibling service from the typed
 * `server.services` config — replacing the per-client boilerplate of reading
 * `Config.getAny('server')` with a loose cast and hand-building the host/port.
 *
 * @example
 *   export const messageClient = createServiceClient('message');
 */
export function createServiceClient(service: InternalService): InternalHttpClient {
  const { services } = Config.get('server');
  return new InternalHttpClient({
    host: services[`${service}Host`],
    port: services[`${service}Port`],
  });
}

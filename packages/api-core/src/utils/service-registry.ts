// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt, envStr } from './env.js';

/**
 * Every service in the internal fleet — the names services sign their service
 * tokens with (`SERVICE_NAME`) and the default in-cluster hostnames.
 */
export const INTERNAL_SERVICES = [
  'ask', 'billing', 'compliance', 'image-registry', 'message',
  'pipeline', 'platform', 'plugin', 'quota', 'reporting',
] as const;

export type InternalService = typeof INTERNAL_SERVICES[number];

/**
 * Where a sibling service listens: `<NAME>_SERVICE_HOST` / `<NAME>_SERVICE_PORT`
 * (e.g. `IMAGE_REGISTRY_SERVICE_HOST`), defaulting to the service name and 3000.
 * The single source every internal client resolves an address from.
 */
export function serviceEndpoint(service: InternalService): { host: string; port: number } {
  const prefix = service.toUpperCase().replace(/-/g, '_');
  return {
    host: envStr(`${prefix}_SERVICE_HOST`, service),
    port: envInt(`${prefix}_SERVICE_PORT`, 3000, { min: 1 }),
  };
}

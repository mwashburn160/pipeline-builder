// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { registerAllRoutes } from './routes';
import { registerSchemas } from './schema-registry';

/** Shared OpenAPI registry for all schema and path registrations. */
export const registry = new OpenAPIRegistry();

/** Options for customizing the generated OpenAPI spec. */
export interface OpenApiSpecOptions {
  title?: string;
  version?: string;
  description?: string;
  serverUrl?: string;
}

let _initialized = false;

/** Execute all registrations once. */
function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;
  registerSchemas();
  registerAllRoutes();
}

/**
 * Generate the complete OpenAPI 3.1.0 specification document.
 *
 * @param options - Optional overrides for spec metadata
 * @returns OpenAPI 3.1 specification object
 */
export function generateOpenApiSpec(
  options?: OpenApiSpecOptions,
): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  ensureInitialized();

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: options?.title ?? 'Pipeline Builder API',
      version: options?.version ?? '1.0.0',
      description: options?.description ?? 'CI/CD Pipeline Builder Platform API — manage pipelines, plugins, messages, quotas, and billing.',
    },
    servers: [
      { url: options?.serverUrl ?? '/api', description: 'API base path' },
    ],
  });
}

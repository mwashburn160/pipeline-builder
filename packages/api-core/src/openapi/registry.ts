import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

/** Shared OpenAPI registry for all schema and path registrations. */
export const registry = new OpenAPIRegistry();

/** Options for customizing the generated OpenAPI spec. */
export interface OpenApiSpecOptions {
  title?: string;
  version?: string;
  description?: string;
  serverUrl?: string;
}

/** Registration callbacks queued by schema-registry and route modules. */
const registrationCallbacks: Array<() => void> = [];
let _initialized = false;

/** Queue a registration callback. Called by schema-registry and route modules. */
export function addRegistration(callback: () => void): void {
  registrationCallbacks.push(callback);
}

/** Execute all queued registrations once. */
function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;
  for (const cb of registrationCallbacks) {
    cb();
  }
}

/**
 * Generate the complete OpenAPI 3.1.0 specification document.
 *
 * @param options - Optional overrides for spec metadata
 * @returns OpenAPI 3.1 specification object
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateOpenApiSpec(options?: OpenApiSpecOptions): any {
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

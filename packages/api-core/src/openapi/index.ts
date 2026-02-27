/**
 * @module openapi
 * @description OpenAPI 3.1 specification generation from Zod schemas.
 *
 * All schema and route registrations are deferred — they queue callbacks via
 * {@link addRegistration} that only execute when {@link generateOpenApiSpec}
 * is first called. Importing this module has no side effects on Zod.
 *
 * @example
 * ```typescript
 * import { generateOpenApiSpec } from '@mwashburn160/api-core';
 *
 * const spec = generateOpenApiSpec({ title: 'My API', version: '2.0.0' });
 * ```
 */

// Queue schema registrations (deferred — only queues callbacks, no side effects)
import './schema-registry';

// Queue route registrations (deferred — only queues callbacks, no side effects)
import './routes/pipeline-routes';
import './routes/plugin-routes';
import './routes/message-routes';
import './routes/quota-routes';
import './routes/billing-routes';

// Public API
export { registry, generateOpenApiSpec } from './registry';
export type { OpenApiSpecOptions } from './registry';

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

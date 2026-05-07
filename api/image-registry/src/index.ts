// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, requireAuth } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext } from '@pipeline-builder/api-server';

import { config } from './config';
import { createImageRoutes } from './routes/images';
import { createTokenRoute } from './routes/token';

const logger = createLogger('pipeline-image-registry');

const { app, sseManager } = createApp({});

app.use(attachRequestContext(sseManager));

// Docker registry token endpoint — Basic auth (validated inside the route);
// must NOT go through requireAuth since it accepts platform-JWT-as-password
// AND (when PLATFORM_BASE_URL is set) `docker login` creds proxied to
// platform's /auth/login. The route itself returns 401 + WWW-Authenticate
// when creds are missing/invalid.
app.use('/token', createTokenRoute());

// Image management API — JWT-authenticated, system-admin gated per-route.
app.use('/api/images', requireAuth, createImageRoutes());

runServer(app, {
  name: 'pipeline-image-registry',
  port: config.port,
  onBeforeStart: async () => {
    logger.info('Service starting', {
      port: config.port,
      registryHost: config.registry.host,
      registryPort: config.registry.port,
    });
  },
});

export { app };

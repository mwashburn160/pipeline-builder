// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { InternalHttpClient, type ServiceConfig } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const serverConfig = Config.getAny('server') as {
  services: { platformHost: string; platformPort: number };
};

const platformServiceConfig: ServiceConfig = {
  host: serverConfig.services.platformHost,
  port: serverConfig.services.platformPort,
};

// Platform owns the EmailService + user directory; compliance POSTs
// /internal/notify-email to it (see platform/src/routes/notify-email.ts).
export const emailClient = new InternalHttpClient(platformServiceConfig);

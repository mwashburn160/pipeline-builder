import { InternalHttpClient, type ServiceConfig } from '@mwashburn160/api-core';
import { Config } from '@mwashburn160/pipeline-core';

const serverConfig = Config.getAny('server') as {
  services: { messageHost: string; messagePort: number };
};

const messageServiceConfig: ServiceConfig = {
  host: serverConfig.services.messageHost,
  port: serverConfig.services.messagePort,
};

export const messageClient = new InternalHttpClient(messageServiceConfig);

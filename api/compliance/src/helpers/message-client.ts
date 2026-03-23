import { InternalHttpClient, type ServiceConfig } from '@mwashburn160/api-core';

const messageServiceConfig: ServiceConfig = {
  host: process.env.MESSAGE_SERVICE_HOST ?? 'message',
  port: parseInt(process.env.MESSAGE_SERVICE_PORT ?? '3000', 10),
};

export const messageClient = new InternalHttpClient(messageServiceConfig);

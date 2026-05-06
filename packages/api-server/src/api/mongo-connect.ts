// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';

const logger = createLogger('mongo-connect');

/**
 * Minimal shape of mongoose accepted by `connectMongo`. Passing the real
 * mongoose object satisfies it; api-server takes mongoose as a parameter
 * (dependency injection) so it doesn't have to declare mongoose as a
 * dependency itself.
 */
interface MongooseLike {
  set(option: string, value: unknown): unknown;
  connection: {
    on(event: string, listener: (err?: Error) => void): unknown;
  };
  connect(uri: string, options: {
    maxPoolSize: number;
    minPoolSize: number;
    serverSelectionTimeoutMS: number;
  }): Promise<unknown>;
}

/**
 * Connect to MongoDB with sensible production-ready pool defaults and
 * standard event-handler wiring (error / disconnected / reconnected).
 *
 * Pool sizing is read from env (`MONGO_MAX_POOL`, `MONGO_MIN_POOL`,
 * `MONGO_SERVER_SELECTION_MS`). Without these the driver default of
 * `maxPoolSize=100` lets a burst exhaust Mongo's connection ceiling
 * across replicas. Defaults: 20 max / 2 min / 5s server selection.
 *
 * Pass the service's own mongoose instance — api-server doesn't bundle
 * mongoose itself.
 */
export async function connectMongo(mongoose: MongooseLike, uri: string): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', { error: err?.message });
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });

  const maxPoolSize = parseInt(process.env.MONGO_MAX_POOL || '20', 10);
  const minPoolSize = parseInt(process.env.MONGO_MIN_POOL || '2', 10);
  const serverSelectionTimeoutMS = parseInt(process.env.MONGO_SERVER_SELECTION_MS || '5000', 10);

  await mongoose.connect(uri, { maxPoolSize, minPoolSize, serverSelectionTimeoutMS });
  logger.info('MongoDB connection established', { maxPoolSize, minPoolSize, serverSelectionTimeoutMS });
}

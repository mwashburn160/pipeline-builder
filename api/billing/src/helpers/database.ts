// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';

const logger = createLogger('database');

/**
 * Connect to MongoDB and register connection event handlers.
 *
 * Pool sizing is read from env (`MONGO_MAX_POOL`, `MONGO_MIN_POOL`,
 * `MONGO_SERVER_SELECTION_MS`). Without these the driver default of
 * `maxPoolSize=100` lets a burst exhaust Mongo's connection ceiling
 * across replicas. Sane defaults: 20 max / 2 min / 5s server selection.
 *
 * @param uri - MongoDB connection string
 */
export async function connectDatabase(uri: string): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', { error: err.message });
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

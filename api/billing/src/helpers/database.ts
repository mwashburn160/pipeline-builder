/**
 * @module helpers/database
 * @description Mongoose connection lifecycle management.
 */

import { createLogger } from '@mwashburn160/api-core';
import mongoose from 'mongoose';

const logger = createLogger('database');

/**
 * Connect to MongoDB and register connection event handlers.
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

  await mongoose.connect(uri);
  logger.info('MongoDB connection established');
}

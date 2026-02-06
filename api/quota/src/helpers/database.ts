/**
 * @module helpers/database
 * @description Mongoose connection lifecycle management.
 *
 * Encapsulates connect, event listeners, and graceful shutdown
 * so index.ts stays lean.
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

/**
 * Register graceful shutdown handlers for an HTTP server + MongoDB.
 *
 * @param server - The listening HTTP server
 * @param timeoutMs - Hard shutdown timeout (default 15 s)
 */
export function registerShutdown(
  server: ReturnType<import('express').Express['listen']>,
  timeoutMs = 15_000,
): void {
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully...`);

    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await mongoose.connection.close(false);
        logger.info('MongoDB connection closed');
      } catch (error) {
        logger.error('Error closing MongoDB', { error });
      }
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, timeoutMs);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

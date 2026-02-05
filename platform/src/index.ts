/**
 * @module platform
 * @description Main entry point for the Platform microservice.
 * Provides user authentication, organization management, and proxies to plugin/pipeline services.
 *
 * Features:
 * - JWT-based authentication with refresh tokens
 * - Organization and user management
 * - Invitation system for onboarding
 * - Rate limiting and quota management
 * - Health check and metrics endpoints
 */

import net from 'net';
import cors from 'cors';
import express, { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';

import { config } from './config';
import { notFoundHandler, errorHandler } from './middleware';
import { authRoutes, oauthRoutes, userRoutes, usersRoutes, organizationRoutes, organizationsRoutes, invitationRoutes, pluginRoutes, pipelineRoutes } from './routes';
import { logger } from './utils';

/** Express application instance */
const app = express();

/**
 * Rate limiter configuration.
 * Extracts client IP from x-forwarded-for header for proxy support.
 */
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  keyGenerator: (req) => {
    let ip = req.ip;
    if (req.headers['x-forwarded-for']) {
      ip = (req.headers['x-forwarded-for'] as string).split(',')[0].trim();
    }
    if (!ip || net.isIPv6(ip)) {
      return ipKeyGenerator(ip || 'unknown', 64);
    }
    return ip;
  },
  message: { success: false, statusCode: 429, message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Configure security and parsing middleware */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(config.cors));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.set('trust proxy', config.server.trustProxy);
app.use(limiter);

/**
 * Health check endpoint for load balancers and orchestration.
 * Returns database connection status.
 *
 * @route GET /health
 * @returns {Object} 200 - Service healthy with DB connected
 * @returns {Object} 503 - Service unhealthy (DB disconnected or error)
 */
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    const isHealthy = dbStatus === 'connected';

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      database: dbStatus,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Metrics endpoint for monitoring and observability.
 * Returns process uptime, memory usage, CPU usage, and database state.
 *
 * @route GET /metrics
 * @returns {Object} 200 - Service metrics
 */
app.get('/metrics', (_req: Request, res: Response) => {
  const readyStates: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    database: {
      state: mongoose.connection.readyState,
      status: readyStates[mongoose.connection.readyState] || 'unknown',
    },
  });
});

/*
 * API Routes
 * Note: nginx strips /api prefix before proxying to this service
 */
app.use('/auth', authRoutes);
app.use('/auth/oauth', oauthRoutes);
app.use('/user', userRoutes);
app.use('/users', usersRoutes);
app.use('/organization', organizationRoutes);
app.use('/organizations', organizationsRoutes);
app.use('/invitation', invitationRoutes);
app.use('/plugin', pluginRoutes);
app.use('/pipeline', pipelineRoutes);

/** Error handling middleware (must be registered last) */
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Initialize MongoDB connection and start the HTTP server.
 * Sets up graceful shutdown handlers for SIGINT and SIGTERM signals.
 *
 * @returns Promise that resolves when server is listening
 * @throws Exits process with code 1 on startup failure
 */
async function startServer(): Promise<void> {
  try {
    logger.info('Starting platform microservice...');

    // Configure Mongoose
    mongoose.set('strictQuery', true);

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });

    // Connect to MongoDB
    await mongoose.connect(config.mongodb.uri);
    logger.info('MongoDB connection established');

    // Start HTTP server
    const server = app.listen(config.app.port, () => {
      logger.info(`Platform microservice listening on port: ${config.app.port}`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully...`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await mongoose.connection.close(false);
          logger.info('MongoDB connection closed');
        } catch (error) {
          logger.error('Error closing MongoDB:', error);
        }

        process.exit(0);
      });

      // Force shutdown after timeout
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 15000);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start
startServer().catch((error) => {
  logger.error('Unhandled error during startup:', error);
  process.exit(1);
});

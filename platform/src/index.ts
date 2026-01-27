import net from 'net';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import { Algorithm } from 'jsonwebtoken';
import mongoose from 'mongoose';
import authRouter from './routes/auth.route';
import orgRouter from './routes/organization.routes';
import userRouter from './routes/user.route';
import logger from './utils/logger.utils';

/**
 * Application configuration
 * Loads from environment variables with sensible defaults
 */
export const config = {
  app: {
    port: parseInt(process.env.PORT || '3000'),
  },
  server: {
    trustProxy: parseInt(process.env.TRUST_PROXY || '1'),
  },
  cors: {
    credentials: process.env.CORS_CREDENTIALS === 'false' ? false : true,
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : '*',
  },
  rateLimit: {
    max: parseInt(process.env.LIMITER_MAX || '100'),
    windowMs: parseInt(process.env.LIMITER_WINDOWMS || '900000'),
  },
  auth: {
    jwt: {
      secret: process.env.JWT_SECRET || 'no-secret',
      expiresIn: parseInt(process.env.JWT_EXPIRES_IN || '7200'),
      algorithm: (process.env.JWT_ALGORITHM as Algorithm) || 'HS256',
      saltRounds: parseInt(process.env.JWT_SALT_ROUNDS || '12'),
    },
    refreshToken: {
      secret: process.env.REFRESH_TOKEN_SECRET || 'no-secret',
      expiresIn: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || '2592000'),
    },
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://mongo:password@mongodb:27017/platform?replicaSet=rs0&authSource=admin',
  },
} as const;

/**
 * Initialize Express app
 */
const app = express();

/**
 * Rate limiter configuration
 * Extracts real IP from x-forwarded-for header when behind proxy
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
  message: { error: 'Too many requests', message: 'Please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Middleware setup
 */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(config.cors));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.set('trust proxy', config.server.trustProxy);
app.use(limiter);

/**
 * Health check endpoint
 * Returns service and database health status
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
 * Metrics endpoint
 * Returns service performance metrics
 */
app.get('/metrics', (_req: Request, res: Response) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    database: {
      state: mongoose.connection.readyState,
      states: {
        0: 'disconnected',
        1: 'connected',
        2: 'connecting',
        3: 'disconnecting',
      },
    },
  });
});

/**
 * API Routes
 */
app.use('/auth', authRouter);
app.use('/user', userRouter);
app.use('/organization', orgRouter);

/**
 * 404 handler for undefined routes
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource could not be found',
  });
});

/**
 * Global error handler
 * Logs errors and returns appropriate responses
 */
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || 500;

  logger.error(`${req.method} ${req.originalUrl} - ${status}`, {
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });

  res.status(status).json({
    success: false,
    error: process.env.NODE_ENV === 'production'
      ? (status >= 500 ? 'Internal Server Error' : 'An error occurred')
      : err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

/**
 * Start the Express server with MongoDB connection and graceful shutdown
 */
async function startServer(): Promise<void> {
  try {
    console.log('[Server] Starting platform microservice...');

    // Configure Mongoose
    mongoose.set('strictQuery', true);

    // MongoDB event handlers
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
    console.log('[Server] MongoDB connection established');
    logger.info('✅ MongoDB connection established');

    // Start HTTP server
    const server = app.listen(config.app.port, () => {
      console.log(`✅ Platform microservice listening on port: ${config.app.port}`);
      logger.info(`✅ Server is running on port ${config.app.port}`);
    });

    /**
     * Graceful shutdown handler
     * Closes HTTP server and MongoDB connection
     */
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received, shutting down gracefully...`);
      logger.info(`${signal} received. Closing HTTP server...`);

      server.close(async () => {
        console.log('✅ HTTP server closed');

        // Close MongoDB connection
        try {
          await mongoose.connection.close(false);
          console.log('✅ MongoDB connection closed');
          logger.info('✅ Connections closed. Process exiting.');
        } catch (error) {
          console.error('❌ Error closing MongoDB:', error);
          logger.error('Error closing MongoDB connection:', error);
        }

        process.exit(0);
      });

      // Force shutdown after 15 seconds
      setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 15000);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    logger.error('Critical Failure: Server could not start', error);
    process.exit(1);
  }
}

// Start the server
void startServer().catch((error) => {
  console.error('❌ Unhandled error during startup:', error);
  logger.error('Unhandled error during startup:', error);
  process.exit(1);
});
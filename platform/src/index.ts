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

const requireEnvVar = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `❌ Required environment variable ${name} is not set. ` +
      'Please set this variable before starting the application.',
    );
  }
  return value;
};

export const config = {
  app: {
    port: parseInt(process.env.PORT || '3000'),
  },
  cors: {
    credentials: process.env.CORS_CREDENTIALS === 'false' ? false : true,
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : '*',
  },
  limiter: {
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
    uri: requireEnvVar('MONGODB_URI'),
  },
} as const;

const app = express();
const limiter = rateLimit({
  windowMs: config.limiter.windowMs,
  max: config.limiter.max,
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

app.use(helmet());
app.use(cors(config.cors));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
app.use(limiter);

app.get('/health', async (_req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.status(dbStatus === 'connected' ? 200 : 503).json({
    status: dbStatus === 'connected' ? 'healthy' : 'unhealthy',
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', (_req, res) => {
  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
  });
});

app.use('/auth', authRouter);
app.use('/user', userRouter);
app.use('/organization', orgRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource could not be found',
  });
});

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

async function startServer() {
  try {
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

    await mongoose.connect(config.mongodb.uri);
    logger.info('✔ MongoDB connection established');

    const server = app.listen(config.app.port, () => {
      logger.info(`✔ Server is running on port ${config.app.port}`);
    });

    const gracefulShutdown = (signal: string) => {
      logger.info(`${signal} received. Closing HTTP server...`);
      server.close(async () => {
        await mongoose.connection.close(false);
        logger.info('✔ Connections closed. Process exiting.');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  } catch (err) {
    logger.error('Critical Failure: Server could not start', err);
    process.exit(1);
  }
}

void startServer();
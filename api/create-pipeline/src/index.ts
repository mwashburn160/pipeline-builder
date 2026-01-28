import {
  // Config
  Config,

  // Core types
  AccessModifier,

  // Database
  db,
  getConnection,
  schema,

  // HTTP
  SSEEventType,
  SSEManager,

  // Pipeline types
  BuilderProps,
} from '@mwashburn160/pipeline-lib';

import cors from 'cors';
import { and, eq } from 'drizzle-orm';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { v7 as uuid } from 'uuid';

/**
 * Request body interface for pipeline creation/update
 */
interface PipelineRequestBody {
  readonly project: string;
  readonly organization: string;
  readonly accessModifier?: AccessModifier;
  readonly props: Record<string, BuilderProps>;
}

/**
 * Type-safe request with body
 */
type TypedRequest = Request<{}, {}, PipelineRequestBody>;

/**
 * Initialize configuration and app
 */
const config = Config.get();
const app = express();
const sseManager = new SSEManager();

/**
 * Rate limiter configuration
 */
const limiter = rateLimit({
  max: parseInt(config.rateLimit.max),
  windowMs: parseInt(config.rateLimit.windowMs),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Middleware setup
 */
app.use(cors(config.server.cors));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(limiter);
app.set('trust proxy', parseInt(config.server.trustProxy));

/**
 * Health check endpoint
 */
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const connection = getConnection();
    const isHealthy = await connection.testConnection();

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      database: isHealthy ? 'connected' : 'disconnected',
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
 */
app.get('/metrics', (_req: Request, res: Response) => {
  const connection = getConnection();
  const stats = connection.getStats();

  res.json({
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    database: {
      totalConnections: stats.totalCount,
      idleConnections: stats.idleCount,
      waitingConnections: stats.waitingCount,
    },
  });
});

/**
 * SSE logs endpoint
 */
app.get('/logs/:requestId', sseManager.middleware());

/**
 * JWT authentication middleware
 */
function authenticateToken(req: Request, res: Response, next: Function): void {
  const auth = req.headers.authorization;
  const token = auth && auth.split(' ')[1];

  if (!token) {
    res.status(401).json({ message: 'Authorization required.' });
    return;
  }

  try {
    jwt.verify(token, config.auth.jwt.secret, {
      algorithms: [config.auth.jwt.algorithm],
    });
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ message: 'Token has expired.' });
      return;
    }
    res.status(403).json({ message: 'Invalid token.' });
    return;
  }
}

/**
 * Extract identity information from request headers
 */
const getIdentity = (req: TypedRequest) => {
  const getHeader = (name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  return {
    orgId: getHeader('x-org-id'),
    userId: getHeader('x-user-id'),
    requestId: getHeader('x-request-id'),
  };
};

/**
 * Create or update pipeline configuration
 * POST /
 *
 * Creates a new pipeline or updates existing one. Sets the new pipeline as default
 * and marks all other pipelines for the same project/org as non-default.
 *
 * ACCESS CONTROL:
 * - accessModifier='public' creates pipeline accessible to all organizations
 * - accessModifier='private' creates pipeline accessible only to the creating organization
 * - orgId always reflects the actual organization that created the pipeline
 */
app.post('/', authenticateToken, async (req: TypedRequest, res: Response) => {
  // Extract identity from headers
  const identity = getIdentity(req);
  const requestId = identity.requestId || uuid();

  // Set X-Request-Id header on response for client-side tracing
  res.setHeader('X-Request-Id', requestId);

  const log = (type: SSEEventType, message: string, data?: unknown) => {
    console.log(`[${requestId}] [${type}] ${message}`, data ?? '');
    sseManager.send(requestId, type, message, data);
  };

  try {
    const { project, organization, props } = req.body;
    const accessModifier = req.body.accessModifier === 'public' ? 'public' : 'private';

    log('INFO', 'Pipeline creation request received', {
      project,
      organization,
      accessModifier,
    });

    // Validate orgId is present
    if (!identity.orgId) {
      log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        error: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    const orgId = identity.orgId.toLowerCase();

    log('INFO', 'Identity validated', {
      orgId: orgId,
      userId: identity.userId,
      requestId,
    });

    // Validate required fields
    if (!project || !organization) {
      log('ERROR', 'Missing required fields', {
        hasProject: !!project,
        hasOrganization: !!organization,
      });
      return res.status(400).json({
        error: 'project and organization are required',
      });
    }

    if (!props || typeof props !== 'object') {
      log('ERROR', 'Invalid or missing props');
      return res.status(400).json({
        error: 'props object is required',
      });
    }

    log('INFO', 'Access policy determined', {
      accessModifier,
      orgId: orgId,
      behavior: accessModifier === 'public' ? 'public (accessible to all)' : 'private (org-specific)',
    });

    log('INFO', 'Starting database transaction');

    // Use transaction to ensure atomicity
    const result = await db.transaction(async (tx) => {
      // Unset current default pipeline(s) for this project/org
      const updateResult = await tx
        .update(schema.pipeline)
        .set({
          isDefault: false,
          updatedAt: new Date(),
          updatedBy: identity.userId || 'system',
        })
        .where(
          and(
            eq(schema.pipeline.project, project.toLowerCase()),
            eq(schema.pipeline.organization, organization.toLowerCase()),
            eq(schema.pipeline.isDefault, true),
          ),
        );

      log('INFO', 'Unmarked previous default pipelines', {
        affected: updateResult ? 'success' : 'none',
      });

      // Insert new pipeline as default
      const [inserted] = await tx
        .insert(schema.pipeline)
        .values({
          orgId: orgId,
          project: project.toLowerCase(),
          organization: organization.toLowerCase(),
          props: props as unknown as BuilderProps,
          accessModifier: accessModifier as any,
          isDefault: true,
          isActive: true,
          createdBy: identity.userId || 'system',
        })
        .returning();

      log('INFO', 'New pipeline created', {
        id: inserted.id,
        orgId: inserted.orgId,
        accessModifier: inserted.accessModifier,
        createdBy: inserted.createdBy,
      });

      return inserted;
    });

    log('COMPLETED', 'Pipeline configuration saved successfully', {
      id: result.id,
      project: result.project,
      organization: result.organization,
      orgId: result.orgId,
      accessModifier: result.accessModifier,
      isDefault: result.isDefault,
    });

    return res.status(201).json({
      id: result.id,
      project: result.project,
      organization: result.organization,
      pipelineName: result.pipelineName,
      accessModifier: result.accessModifier,
      isDefault: result.isDefault,
      isActive: result.isActive,
      createdAt: result.createdAt,
      createdBy: result.createdBy,
      message: accessModifier === 'public'
        ? 'Public pipeline created successfully (accessible to all organizations)'
        : `Private pipeline created successfully (accessible to ${orgId} only)`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;

    // Extract database error details if available
    const dbError = error && typeof error === 'object' ? error as any : null;
    const dbCode = dbError?.code;
    const dbDetail = dbError?.detail;
    const dbHint = dbError?.hint;
    const dbConstraint = dbError?.constraint;

    // Log full error details including any database-specific errors
    log('ERROR', 'Pipeline save failed', {
      message,
      stack,
      ...(dbCode && { dbCode }),
      ...(dbDetail && { dbDetail }),
      ...(dbHint && { dbHint }),
      ...(dbConstraint && { dbConstraint }),
    });
    log('ROLLBACK', 'Transaction rolled back');

    return res.status(500).json({
      error: 'Failed to save pipeline configuration',
      message: message,
      ...(dbConstraint && { constraint: dbConstraint }),
    });
  }
});

/**
 * Start the Express server with graceful shutdown
 */
async function startServer(): Promise<void> {
  try {
    console.log('[Server] Starting pipeline POST microservice...');

    // Test database connection
    const connection = getConnection();
    const dbHealthy = await connection.testConnection();

    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    console.log('[Server] Database connection established');

    const server = app.listen(config.server.port, () => {
      console.log(`✅ Pipeline POST microservice listening on port: ${config.server.port}`);
      console.log(`✅ Platform URL: ${config.server.platformUrl}`);
    });

    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received, shutting down gracefully...`);

      // Shutdown SSE manager to close all client connections

      console.log('✅ SSE connections closed');

      server.close(async () => {
        console.log('✅ HTTP server closed');

        // Close database connection
        try {
          await connection.close();
          console.log('✅ Database connection closed');
        } catch (error) {
          console.error('❌ Error closing database:', error);
        }

        process.exit(0);
      });

      // Force shutdown after 15 seconds
      setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        process.exit(1);
      }, 15000);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
void startServer().catch((error) => {
  console.error('❌ Unhandled error during startup:', error);
  process.exit(1);
});
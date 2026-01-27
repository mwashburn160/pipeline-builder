import { BuilderProps, Config, db, getConnection, schema, SSEEventType, SSEManager } from '@mwashburn160/pipeline-lib';
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
  readonly accessModifier?: 'public' | 'private';
  readonly props: Record<string, unknown>; // BuilderProps
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
 * Extract orgId from request headers
 */
const getOrgId = (req: TypedRequest): string | undefined => {
  const orgId = req.headers['x-org-id'];

  if (Array.isArray(orgId)) {
    return orgId[0];
  }

  return typeof orgId === 'string' ? orgId : undefined;
};

/**
 * Determine effective organization ID based on access modifier
 *
 * BEHAVIOR:
 * - If accessModifier is 'public', returns 'system' (public pipeline)
 * - If accessModifier is 'private' or undefined, returns the user's orgId
 */
function getEffectiveOrgId(accessModifier: 'public' | 'private', userOrgId: string): string {
  switch (accessModifier) {
    case 'public':
      return 'system';

    case 'private':
    default:
      return userOrgId.toLowerCase();
  }
}

/**
 * Create or update pipeline configuration
 * POST /
 *
 * Creates a new pipeline or updates existing one. Sets the new pipeline as default
 * and marks all other pipelines for the same project/org as non-default.
 *
 * ACCESS CONTROL:
 * - accessModifier='public' creates pipeline with organization='system' (public)
 * - accessModifier='private' or undefined creates pipeline with user's organization (private)
 */
app.post('/', authenticateToken, async (req: TypedRequest, res: Response) => {
  const requestId = uuid();
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
    const orgId = getOrgId(req);
    if (!orgId) {
      log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        error: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    log('INFO', 'Organization ID validated', { orgId });

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

    // Determine effective organization ID using switch/case pattern
    const effectiveOrgId = getEffectiveOrgId(accessModifier, orgId);

    log('INFO', 'Access policy determined', {
      accessModifier,
      effectiveOrgId,
      behavior: accessModifier === 'public' ? 'public (system)' : 'private (org-specific)',
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
          updatedBy: 'system', // TODO: Get from JWT token
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
          orgId: effectiveOrgId,
          project: project.toLowerCase(),
          organization: organization.toLowerCase(),
          props: props as unknown as BuilderProps,
          accessModifier: accessModifier as any,
          isDefault: true,
          isActive: true,
        })
        .returning();

      log('INFO', 'New pipeline created', {
        id: inserted.id,
        orgId: effectiveOrgId,
        accessModifier: inserted.accessModifier,
      });

      return inserted;
    });

    log('COMPLETED', 'Pipeline configuration saved successfully', {
      id: result.id,
      project: result.project,
      organization: result.organization,
      orgId: effectiveOrgId,
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
      message: accessModifier === 'public'
        ? 'Public pipeline created successfully (accessible to all organizations)'
        : `Private pipeline created successfully (accessible to ${orgId} only)`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;

    log('ERROR', 'Pipeline save failed', { message, stack });
    log('ROLLBACK', 'Transaction rolled back');

    return res.status(500).json({
      error: 'Failed to save pipeline configuration',
      message: message,
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
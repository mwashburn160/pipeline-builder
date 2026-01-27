import { Config, db, getConnection, PipelineFilter, schema, SSEEventType, SSEManager, validatePipelineFilter } from '@mwashburn160/pipeline-lib';
import cors from 'cors';
import { and, eq, or, sql, SQL } from 'drizzle-orm';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { v7 as uuid } from 'uuid';

/**
 * Type-safe request type with params and query
 */
type TypedRequest<T = {}, Q = {}> = Request<{ id?: string }, {}, T, Q>;

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
 * Builds SQL conditions from pipeline filter and orgId
 * 
 * NEW BEHAVIOR:
 * - If accessModifier is explicitly set to 'public', only return system records
 * - If accessModifier is set to 'private', only return orgId records
 * - If accessModifier is NOT set, return both orgId records AND system (public) records
 */
function buildConditions(pipelineFilter: Partial<PipelineFilter>, orgId: string): SQL[] {
  const conditions: SQL[] = [];
  const normalizedOrgId = orgId.toLowerCase();

  // Determine access modifier behavior
  const accessModifier = pipelineFilter.accessModifier !== undefined
    ? (typeof pipelineFilter.accessModifier === 'string'
        ? pipelineFilter.accessModifier.toLowerCase()
        : String(pipelineFilter.accessModifier).toLowerCase())
    : undefined;

  // Organization filter logic using switch/case
  switch (accessModifier) {
    case 'public':
      // Explicitly requesting public records only
      conditions.push(eq(schema.pipeline.organization, 'system'));
      break;
    
    case 'private':
      // Explicitly requesting private records only
      conditions.push(eq(schema.pipeline.organization, normalizedOrgId));
      break;
    
    default:
      // No accessModifier specified OR other value
      // Return both organization records AND public (system) records
      conditions.push(
        or(
          eq(schema.pipeline.organization, normalizedOrgId),
          eq(schema.pipeline.organization, 'system')
        )!
      );
      break;
  }

  // Other filters
  if (pipelineFilter.id !== undefined) {
    conditions.push(eq(schema.pipeline.id, pipelineFilter.id as string));
  }

  if (pipelineFilter.project !== undefined) {
    const value = typeof pipelineFilter.project === 'string'
      ? pipelineFilter.project.toLowerCase()
      : pipelineFilter.project;
    conditions.push(eq(schema.pipeline.project, value as string));
  }

  if (pipelineFilter.organization !== undefined) {
    // Allow explicit organization filtering
    const value = typeof pipelineFilter.organization === 'string'
      ? pipelineFilter.organization.toLowerCase()
      : pipelineFilter.organization;
    conditions.push(eq(schema.pipeline.organization, value as string));
  }

  if (pipelineFilter.isDefault !== undefined) {
    const boolValue = typeof pipelineFilter.isDefault === 'string'
      ? pipelineFilter.isDefault === 'true'
      : pipelineFilter.isDefault;
    conditions.push(eq(schema.pipeline.isDefault, boolValue));
  }

  if (pipelineFilter.isActive !== undefined) {
    const boolValue = typeof pipelineFilter.isActive === 'string'
      ? pipelineFilter.isActive === 'true'
      : pipelineFilter.isActive;
    conditions.push(eq(schema.pipeline.isActive, boolValue));
  }

  if (pipelineFilter.accessModifier !== undefined) {
    conditions.push(sql`${schema.pipeline.accessModifier} = ${accessModifier}`);
  }

  return conditions;
}

const getOrgId = (req: TypedRequest): string | undefined => {
  const orgId = req.headers['x-org-id'];

  if (Array.isArray(orgId)) {
    return orgId[0];
  }

  return typeof orgId === 'string' ? orgId : undefined;
};

/**
 * Query pipelines with filters (returns multiple results)
 * GET /?project=my-app&organization=my-org
 * 
 * NEW BEHAVIOR:
 * - GET / returns all pipelines for orgId + public pipelines
 * - GET /?accessModifier=public returns only public pipelines
 * - GET /?accessModifier=private returns only org-specific pipelines
 */
app.get('/', authenticateToken, async (req: TypedRequest<{}, Partial<PipelineFilter>>, res: Response) => {
  const requestId = uuid();
  const log = (type: SSEEventType, message: string, data?: unknown) => {
    console.log(`[${requestId}] [${type}] ${message}`, data ?? '');
    sseManager.send(requestId, type, message, data);
  };

  log('INFO', 'Pipeline query request received', { query: req.query });

  try {
    const pipelineFilter = req.query;
    const orgId = getOrgId(req);

    // orgId is required for authenticated requests
    if (!orgId) {
      log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        message: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    log('INFO', 'Organization ID validated', { 
      orgId, 
      accessModifier: pipelineFilter.accessModifier || 'not specified (will return org + public)' 
    });

    // Validate filter
    try {
      validatePipelineFilter(pipelineFilter as PipelineFilter);
    } catch (validationError) {
      log('ERROR', 'Filter validation failed', { error: validationError });
      return res.status(400).json({
        message: validationError instanceof Error ? validationError.message : 'Invalid filter',
      });
    }

    const where = buildConditions(pipelineFilter, orgId);

    log('INFO', 'Executing database query', {
      filterCount: where.length,
      filters: pipelineFilter,
      orgId,
      behavior: pipelineFilter.accessModifier === 'public' 
        ? 'public only'
        : pipelineFilter.accessModifier === 'private'
        ? 'private only'
        : 'org + public'
    });

    // Apply limit from filter or use default
    const limit = pipelineFilter.limit ? parseInt(String(pipelineFilter.limit)) : 50;
    const offset = pipelineFilter.offset ? parseInt(String(pipelineFilter.offset)) : 0;

    const results = await db
      .select()
      .from(schema.pipeline)
      .where(and(...where))
      .limit(limit)
      .offset(offset);

    if (results.length === 0) {
      log('INFO', 'No pipelines found matching the criteria');
      return res.status(404).json({
        message: 'No pipelines found matching the criteria.',
        data: [],
        count: 0,
      });
    }

    log('COMPLETED', 'Successfully retrieved pipelines', { 
      count: results.length,
      organizations: [...new Set(results.map(r => r.organization))]
    });
    
    return res.status(200).json({
      message: 'Pipelines retrieved successfully',
      data: results,
      count: results.length,
      limit,
      offset,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred.';
    const stack = error instanceof Error ? error.stack : undefined;

    log('ERROR', 'Pipeline query failed', { error: message, stack });

    return res.status(500).json({ message });
  }
});

/**
 * Start the Express server with graceful shutdown
 */
async function startServer(): Promise<void> {
  try {
    console.log('[Server] Starting pipeline microservice (multi-result)...');

    // Test database connection
    const connection = getConnection();
    const dbHealthy = await connection.testConnection();

    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    console.log('[Server] Database connection established');

    const server = app.listen(config.server.port, () => {
      console.log(`✅ Pipeline microservice listening on port: ${config.server.port}`);
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
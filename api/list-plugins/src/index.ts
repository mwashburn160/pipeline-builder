import { Config, db, getConnection, PluginFilter, schema, SSEEventType, SSEManager, validatePluginFilter } from '@mwashburn160/pipeline-lib';
import cors from 'cors';
import { and, eq, sql, SQL } from 'drizzle-orm';
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
app.set('trust proxy', true);

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
 * Builds SQL conditions from plugin filter and orgId
 */
function buildConditions(pluginFilter: Partial<PluginFilter>, orgId: string): SQL[] {
  const conditions: SQL[] = [];

  // Check if accessModifier is set to 'public'
  const isPublicAccess = pluginFilter.accessModifier !== undefined &&
    (typeof pluginFilter.accessModifier === 'string'
      ? pluginFilter.accessModifier.toLowerCase() === 'public'
      : String(pluginFilter.accessModifier).toLowerCase() === 'public');

  // If public access, use 'system' as orgId, otherwise use provided orgId
  const effectiveOrgId = isPublicAccess ? 'system' : orgId;
  conditions.push(eq(schema.plugin.orgId, effectiveOrgId));

  if (pluginFilter.id !== undefined) {
    conditions.push(eq(schema.plugin.id, pluginFilter.id as string));
  }

  if (pluginFilter.orgId !== undefined) {
    // This will create an AND condition with the orgId condition above
    // Only useful if you want to allow filtering by orgId within the user's scope
    conditions.push(eq(schema.plugin.orgId, pluginFilter.orgId as string));
  }

  if (pluginFilter.name !== undefined) {
    const value = typeof pluginFilter.name === 'string'
      ? pluginFilter.name.toLowerCase()
      : pluginFilter.name;
    conditions.push(eq(schema.plugin.name, value as string));
  }

  if (pluginFilter.version !== undefined) {
    conditions.push(eq(schema.plugin.version, pluginFilter.version as string));
  }

  if (pluginFilter.imageTag !== undefined) {
    conditions.push(eq(schema.plugin.imageTag, pluginFilter.imageTag as string));
  }

  if (pluginFilter.isDefault !== undefined) {
    const boolValue = typeof pluginFilter.isDefault === 'string'
      ? pluginFilter.isDefault === 'true'
      : pluginFilter.isDefault;
    conditions.push(eq(schema.plugin.isDefault, boolValue));
  }

  if (pluginFilter.isActive !== undefined) {
    const boolValue = typeof pluginFilter.isActive === 'string'
      ? pluginFilter.isActive === 'true'
      : pluginFilter.isActive;
    conditions.push(eq(schema.plugin.isActive, boolValue));
  }

  if (pluginFilter.accessModifier !== undefined) {
    const value = typeof pluginFilter.accessModifier === 'string'
      ? pluginFilter.accessModifier.toLowerCase()
      : String(pluginFilter.accessModifier).toLowerCase();
    conditions.push(sql`${schema.plugin.accessModifier} = ${value}`);
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
 * Query plugins with filters - returns multiple results
 * GET /?name=nodejs&isActive=true
 */
app.get('/', authenticateToken, async (req: TypedRequest<{}, Partial<PluginFilter>>, res: Response) => {
  const requestId = uuid();
  const log = (type: SSEEventType, message: string, data?: unknown) => {
    console.log(`[${requestId}] [${type}] ${message}`, data ?? '');
    sseManager.send(requestId, type, message, data);
  };

  log('INFO', 'Plugin query request received', { query: req.query });

  try {
    const pluginFilter = req.query;

    // Check if this is a public access request
    const isPublicAccess = pluginFilter.accessModifier !== undefined &&
      (typeof pluginFilter.accessModifier === 'string'
        ? pluginFilter.accessModifier.toLowerCase() === 'public'
        : String(pluginFilter.accessModifier).toLowerCase() === 'public');

    const orgId = getOrgId(req);
    
    // Validate that orgId is present only if not public access
    if (!isPublicAccess && !orgId) {
      log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        message: 'Organization ID is required. Please provide x-org-id header.',
      });
    }
    
    // Use 'system' for public access, actual orgId otherwise
    const effectiveOrgId = isPublicAccess ? 'system' : orgId!;
    log('INFO', 'Organization ID validated', { orgId: effectiveOrgId, isPublicAccess });

    // Validate filter
    try {
      validatePluginFilter(pluginFilter as PluginFilter);
    } catch (validationError) {
      log('ERROR', 'Filter validation failed', { error: validationError });
      return res.status(400).json({
        message: validationError instanceof Error ? validationError.message : 'Invalid filter',
      });
    }

    const where = buildConditions(pluginFilter, effectiveOrgId);

    log('INFO', 'Executing database query', {
      filterCount: where.length,
      filters: pluginFilter,
      orgId: effectiveOrgId,
    });

    // Apply limit from filter or default to 50
    const limit = pluginFilter.limit ? parseInt(String(pluginFilter.limit)) : 50;
    const offset = pluginFilter.offset ? parseInt(String(pluginFilter.offset)) : 0;

    const results = await db
      .select()
      .from(schema.plugin)
      .where(and(...where))
      .limit(limit)
      .offset(offset);

    if (results.length === 0) {
      log('INFO', 'No plugins found matching the criteria');
      return res.status(404).json({
        message: 'No plugins found matching the criteria.',
        data: [],
        count: 0,
      });
    }

    log('COMPLETED', 'Successfully retrieved plugins', { count: results.length });
    return res.status(200).json({
      message: 'Plugins retrieved successfully',
      data: results,
      count: results.length,
      limit,
      offset,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred.';
    const stack = error instanceof Error ? error.stack : undefined;

    log('ERROR', 'Plugin query failed', { error: message, stack });

    return res.status(500).json({ message });
  }
});

/**
 * Start the Express server with graceful shutdown
 */
async function startServer(): Promise<void> {
  try {
    console.log('[Server] Starting plugin list microservice...');
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);

    // Test database connection
    const connection = getConnection();
    const dbHealthy = await connection.testConnection();

    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    console.log('[Server] Database connection established');

    const server = app.listen(config.server.port, () => {
      console.log(`✅ Plugin list microservice listening on port: ${config.server.port}`);
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
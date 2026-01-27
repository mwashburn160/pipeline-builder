import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import { Config, db, getConnection, PluginManifest, schema, SSEEventType, SSEManager } from '@mwashburn160/pipeline-lib';
import AdmZip from 'adm-zip';
import cors from 'cors';
import { eq } from 'drizzle-orm';
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { v7 as uuid } from 'uuid';
import YAML from 'yaml';

/**
 * Request body interface for plugin upload
 */
interface PluginRequestBody {
  readonly accessModifier?: 'public' | 'private';
}

/**
 * Type-safe request with body and file
 */
type TypedRequest = Request<{}, any, PluginRequestBody>;

/**
 * Initialize configuration and app
 */
const config = Config.get();
const app = express();
const sseManager = new SSEManager();

/**
 * Multer configuration for file uploads
 */
const upload = multer({
  limits: {
    files: 1,
    fileSize: 100 * 1024 * 1024, // 100MB
  },
  dest: 'uploads/',
});

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
 * Upload and deploy plugin
 * POST /
 *
 * Accepts a ZIP file containing:
 * - manifest.yaml (required)
 * - dockerfile (required)
 * - source code and dependencies
 *
 * Builds Docker image and pushes to registry
 */
app.post('/', upload.single('plugin'), authenticateToken, async (req: TypedRequest, res: Response) => {
  const requestId = uuid();
  res.setHeader('X-Request-Id', requestId);

  const log = (type: SSEEventType, message: string, data?: unknown) => {
    console.log(`[${requestId}] [${type}] ${message}`, data ?? '');
    sseManager.send(requestId, type, message, data);
  };

  let zipPath: string | undefined;
  let destinationDir: string | undefined;
  const originalCwd = process.cwd();

  try {
    if (!req.file) {
      log('ERROR', 'Upload failed: no plugin file received');
      return res.status(400).json({ error: 'No plugin file uploaded' });
    }

    // Validate orgId is present
    const orgId = getOrgId(req);
    if (!orgId) {
      log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        error: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    log('INFO', 'Organization ID validated', { orgId });

    const accessModifier = req.body.accessModifier === 'public' ? 'public' : 'private';
    
    // For public plugins, use 'system' as orgId, otherwise use the provided orgId
    const effectiveOrgId = accessModifier === 'public' ? 'system' : orgId;
    
    log('INFO', 'Access policy set', { accessModifier, effectiveOrgId });

    zipPath = req.file.path;
    log('INFO', 'Upload received', {
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      mimeType: req.file.mimetype,
    });

    // Read and validate ZIP
    log('INFO', 'Reading ZIP archive');
    const zip = new AdmZip(zipPath);

    const manifestEntry = zip.getEntry('manifest.yaml') || zip.getEntry('manifest');
    if (!manifestEntry) {
      log('ERROR', 'Manifest file not found in ZIP');
      return res.status(400).json({ error: 'manifest.yaml file missing in ZIP' });
    }

    // Parse manifest
    log('INFO', 'Parsing manifest.yaml');
    const manifestContent = zip.readAsText(manifestEntry);
    const manifest: PluginManifest = YAML.parse(manifestContent);

    if (!manifest.name || !manifest.version || !manifest.commands) {
      log('ERROR', 'Manifest validation failed: missing required fields');
      return res.status(400).json({
        error: 'Invalid manifest: name, version, and commands are required',
      });
    }

    log('INFO', 'Manifest validated', {
      pluginName: manifest.name,
      version: manifest.version,
      pluginType: manifest.pluginType || 'CodeBuildStep',
    });

    // Extract ZIP
    log('INFO', 'Extracting ZIP contents');
    destinationDir = path.join(process.cwd(), 'tmp', uuid());
    fs.mkdirSync(destinationDir, { recursive: true });
    zip.extractAllTo(destinationDir, true);
    log('INFO', 'ZIP extraction completed', { destination: destinationDir });

    // Generate image tag
    const imageTag = `p-${manifest.name.replace(/[^a-z0-9]/gi, '')}-${uuid().slice(0, 8)}`.toLowerCase();
    const dockerfile = manifest.dockerfile || 'Dockerfile';

    // Get registry config
    const registry = config.registry;
    const registryAddr = `${registry.host}:${registry.port}`;
    const fullImage = `${registryAddr}/plugin:${imageTag}`;

    // Build and push Docker image
    log('INFO', 'Preparing Docker registry authentication');
    process.chdir(destinationDir);

    log('INFO', 'Performing docker login');
    execSync(
      `echo ${registry.token} | docker login ${registryAddr} --username ${registry.user} --password-stdin`,
      { stdio: 'pipe' },
    );
    log('INFO', 'Docker login successful');

    log('INFO', 'Starting Docker build', { dockerfile, context: '.' });
    execSync(`docker build -f ${dockerfile} -t plugin:${imageTag} .`, { stdio: 'inherit' });
    log('INFO', 'Docker build completed successfully');

    log('INFO', 'Tagging image for registry', { localTag: `plugin:${imageTag}`, fullImage });
    execSync(`docker tag plugin:${imageTag} ${fullImage}`, { stdio: 'inherit' });

    log('INFO', 'Pushing image to registry', { image: fullImage });
    execSync(`docker push ${fullImage}`, { stdio: 'inherit' });
    log('INFO', 'Image push completed');

    // Save to database
    log('INFO', 'Saving plugin to database', { 
      name: manifest.name, 
      version: manifest.version,
      orgId: effectiveOrgId,
    });
    const result = await db.transaction(async (tx) => {
      // Unset current default for this plugin name
      await tx
        .update(schema.plugin)
        .set({
          isDefault: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.plugin.name, manifest.name));

      // Insert new plugin as default
      const [inserted] = await tx
        .insert(schema.plugin)
        .values({
          orgId: effectiveOrgId,
          name: manifest.name,
          description: manifest.description || null,
          version: manifest.version,
          metadata: manifest.metadata || {},
          pluginType: (manifest.pluginType || 'CodeBuildStep') as any,
          computeType: (manifest.computeType || 'SMALL') as any,
          env: manifest.env || {},
          installCommands: manifest.installCommands || [],
          commands: manifest.commands,
          imageTag: imageTag,
          accessModifier: accessModifier as any,
          isDefault: true,
          isActive: true,
        })
        .returning();

      return inserted;
    });

    log('COMPLETED', 'Plugin deployed', {
      id: result.id,
      name: result.name,
      version: result.version,
      orgId: effectiveOrgId,
    });

    return res.status(201).json({
      id: result.id,
      name: result.name,
      version: result.version,
      imageTag: result.imageTag,
      fullImage: fullImage,
      accessModifier: result.accessModifier,
      isDefault: result.isDefault,
      isActive: result.isActive,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    log('ERROR', 'Deployment failed', { error: msg, stack });
    log('ROLLBACK', 'Transaction rolled back');

    return res.status(500).json({
      error: 'Failed to deploy plugin',
      message: msg,
    });
  } finally {
    // Restore original directory
    process.chdir(originalCwd);

    // Cleanup uploaded ZIP
    if (zipPath && fs.existsSync(zipPath)) {
      log('INFO', 'Deleting uploaded ZIP file', { path: zipPath });
      try {
        fs.unlinkSync(zipPath);
      } catch (unlinkErr) {
        log('ERROR', 'Failed to delete uploaded ZIP', {
          error: (unlinkErr as Error).message,
        });
      }
    }

    // Cleanup temporary directory
    if (destinationDir && fs.existsSync(destinationDir)) {
      log('INFO', 'Starting cleanup of temporary directory', { path: destinationDir });
      try {
        fs.rmSync(destinationDir, { recursive: true, force: true });
        log('INFO', 'Temporary directory cleaned up successfully');
      } catch (cleanupErr) {
        log('ERROR', 'Failed to clean up temporary directory', {
          path: destinationDir,
          error: (cleanupErr as Error).message,
        });
      }
    }
  }
});

/**
 * Start the Express server with graceful shutdown
 */
async function startServer(): Promise<void> {
  try {
    console.log('[Server] Starting plugin upload microservice...');
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);

    // Test database connection
    const connection = getConnection();
    const dbHealthy = await connection.testConnection();

    if (!dbHealthy) {
      throw new Error('Database connection failed');
    }

    console.log('[Server] Database connection established');

    // Ensure upload directory exists
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      console.log(`[Server] Created upload directory: ${uploadDir}`);
    }

    const server = app.listen(config.server.port, () => {
      console.log(`✅ Plugin upload microservice listening on port: ${config.server.port}`);
      console.log(`✅ Platform URL: ${config.server.platformUrl}`);
      console.log(`✅ Registry: ${config.registry.host}:${config.registry.port}`);
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
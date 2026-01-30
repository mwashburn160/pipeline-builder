import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';

import {
  // Config
  Config,

  // Database
  db,
  schema,

  // API utilities
  createApp,
  runServer,
  authenticateToken,
  createRequestContext,
  extractDbError,

  // Types
  PluginManifest,
} from '@mwashburn160/pipeline-lib';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import { Request, Response } from 'express';
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
 * Initialize app with common middleware
 */
const { app, sseManager } = createApp();

/**
 * Upload and deploy plugin
 * POST /
 */
app.post('/', upload.single('plugin'), authenticateToken, async (req: Request, res: Response) => {
  const ctx = createRequestContext(req, res, sseManager);
  const config = Config.get();
  const body = req.body as PluginRequestBody;

  let zipPath: string | undefined;
  let destinationDir: string | undefined;
  const originalCwd = process.cwd();

  try {
    if (!req.file) {
      ctx.log('ERROR', 'Upload failed: no plugin file received');
      return res.status(400).json({ success: false, statusCode: 400, error: 'No plugin file uploaded' });
    }

    // Validate orgId
    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        success: false,
        statusCode: 400,
        error: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    const orgId = ctx.identity.orgId.toLowerCase();
    const accessModifier = body.accessModifier === 'public' ? 'public' : 'private';

    ctx.log('INFO', 'Identity validated', { orgId, userId: ctx.identity.userId });
    ctx.log('INFO', 'Access policy determined', { accessModifier, orgId });

    zipPath = req.file.path;
    ctx.log('INFO', 'Upload received', {
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
    });

    // Read and validate ZIP
    ctx.log('INFO', 'Reading ZIP archive');
    const zip = new AdmZip(zipPath);

    const manifestEntry = zip.getEntry('manifest.yaml') || zip.getEntry('manifest');
    if (!manifestEntry) {
      ctx.log('ERROR', 'Manifest file not found in ZIP');
      return res.status(400).json({ success: false, statusCode: 400, error: 'manifest.yaml file missing in ZIP' });
    }

    // Parse manifest
    ctx.log('INFO', 'Parsing manifest.yaml');
    const manifestContent = zip.readAsText(manifestEntry);
    const manifest: PluginManifest = YAML.parse(manifestContent);

    if (!manifest.name || !manifest.version || !manifest.commands) {
      ctx.log('ERROR', 'Manifest validation failed: missing required fields');
      return res.status(400).json({
        success: false,
        statusCode: 400,
        error: 'Invalid manifest: name, version, and commands are required',
      });
    }

    ctx.log('INFO', 'Manifest validated', {
      pluginName: manifest.name,
      version: manifest.version,
    });

    // Extract ZIP
    ctx.log('INFO', 'Extracting ZIP contents');
    destinationDir = path.join(process.cwd(), 'tmp', uuid());
    fs.mkdirSync(destinationDir, { recursive: true });
    zip.extractAllTo(destinationDir, true);

    // Generate image tag
    const imageTag = `p-${manifest.name.replace(/[^a-z0-9]/gi, '')}-${uuid().slice(0, 8)}`.toLowerCase();
    const dockerfileName = manifest.dockerfile || 'Dockerfile';

    // Read dockerfile content
    const dockerfilePath = path.join(destinationDir, dockerfileName);
    let dockerfileContent: string | null = null;
    if (fs.existsSync(dockerfilePath)) {
      dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
    }

    // Get registry config
    const registry = config.registry;
    const registryAddr = `${registry.host}:${registry.port}`;
    const fullImage = `${registryAddr}/plugin:${imageTag}`;

    // Build and push Docker image
    process.chdir(destinationDir);

    ctx.log('INFO', 'Performing docker login');
    execSync(
      `echo ${registry.token} | docker login ${registryAddr} --username ${registry.user} --password-stdin`,
      { stdio: 'pipe' },
    );

    ctx.log('INFO', 'Starting Docker build');
    execSync(`docker build -f ${dockerfileName} -t plugin:${imageTag} .`, { stdio: 'inherit' });

    ctx.log('INFO', 'Tagging and pushing image');
    execSync(`docker tag plugin:${imageTag} ${fullImage}`, { stdio: 'inherit' });
    execSync(`docker push ${fullImage}`, { stdio: 'inherit' });

    ctx.log('INFO', 'Image push completed');

    // Save to database
    ctx.log('INFO', 'Saving plugin to database');

    const result = await db.transaction(async (tx) => {
      // Unset current default
      await tx
        .update(schema.plugin)
        .set({
          isDefault: false,
          updatedAt: new Date(),
          updatedBy: ctx.identity.userId || 'system',
        })
        .where(eq(schema.plugin.name, manifest.name));

      // Insert new plugin
      const [inserted] = await tx
        .insert(schema.plugin)
        .values({
          orgId,
          name: manifest.name,
          description: manifest.description || null,
          version: manifest.version,
          metadata: manifest.metadata || {},
          pluginType: (manifest.pluginType || 'CodeBuildStep') as any,
          computeType: (manifest.computeType || 'SMALL') as any,
          dockerfile: dockerfileContent,
          env: manifest.env || {},
          installCommands: manifest.installCommands || [],
          commands: manifest.commands,
          imageTag,
          accessModifier: accessModifier as any,
          isDefault: true,
          isActive: true,
          createdBy: ctx.identity.userId || 'system',
        })
        .returning();

      return inserted;
    });

    ctx.log('COMPLETED', 'Plugin deployed successfully', {
      id: result.id,
      name: result.name,
      version: result.version,
      imageTag: result.imageTag,
    });

    return res.status(201).json({
      success: true,
      statusCode: 201,
      id: result.id,
      name: result.name,
      version: result.version,
      imageTag: result.imageTag,
      fullImage,
      accessModifier: result.accessModifier,
      isDefault: result.isDefault,
      isActive: result.isActive,
      createdBy: result.createdBy,
      message: accessModifier === 'public'
        ? 'Public plugin deployed successfully (accessible to all organizations)'
        : `Private plugin deployed successfully (accessible to ${orgId} only)`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const dbDetails = extractDbError(error);

    ctx.log('ERROR', 'Deployment failed', { error: message, ...dbDetails });
    ctx.log('ROLLBACK', 'Transaction rolled back');

    return res.status(500).json({
      success: false,
      statusCode: 500,
      error: 'Failed to deploy plugin',
      message,
      ...dbDetails,
    });
  } finally {
    process.chdir(originalCwd);

    // Cleanup
    if (zipPath && fs.existsSync(zipPath)) {
      try { fs.unlinkSync(zipPath); } catch {}
    }
    if (destinationDir && fs.existsSync(destinationDir)) {
      try { fs.rmSync(destinationDir, { recursive: true, force: true }); } catch {}
    }
  }
});

/**
 * Start the server
 */
const config = Config.get();

// Ensure upload directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

runServer(app, {
  name: 'Plugin Upload microservice',
  sseManager,
  onStart: () => {
    console.log(`✅ Registry: ${config.registry.host}:${config.registry.port}`);
  },
});
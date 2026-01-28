import {
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
  AccessModifier,
  BuilderProps,
} from '@mwashburn160/pipeline-lib';
import { and, eq } from 'drizzle-orm';
import { Request, Response } from 'express';


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
 * Initialize app with common middleware
 */
const { app, sseManager } = createApp();

/**
 * Create or update pipeline configuration
 * POST /
 */
app.post('/', authenticateToken, async (req: Request, res: Response) => {
  const ctx = createRequestContext(req, res, sseManager);
  const body = req.body as PipelineRequestBody;

  try {
    const { project, organization, props } = body;
    const accessModifier = body.accessModifier === 'public' ? 'public' : 'private';

    ctx.log('INFO', 'Pipeline creation request received', { project, organization, accessModifier });

    // Validate orgId
    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        error: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    const orgId = ctx.identity.orgId.toLowerCase();
    ctx.log('INFO', 'Identity validated', { orgId, userId: ctx.identity.userId, requestId: ctx.requestId });

    // Validate required fields
    if (!project || !organization) {
      ctx.log('ERROR', 'Missing required fields', { hasProject: !!project, hasOrganization: !!organization });
      return res.status(400).json({ error: 'project and organization are required' });
    }

    if (!props || typeof props !== 'object') {
      ctx.log('ERROR', 'Invalid or missing props');
      return res.status(400).json({ error: 'props object is required' });
    }

    ctx.log('INFO', 'Starting database transaction');

    const result = await db.transaction(async (tx) => {
      // Unset current default pipeline(s)
      await tx
        .update(schema.pipeline)
        .set({
          isDefault: false,
          updatedAt: new Date(),
          updatedBy: ctx.identity.userId || 'system',
        })
        .where(
          and(
            eq(schema.pipeline.project, project.toLowerCase()),
            eq(schema.pipeline.organization, organization.toLowerCase()),
            eq(schema.pipeline.isDefault, true),
          ),
        );

      ctx.log('INFO', 'Unmarked previous default pipelines');

      // Insert new pipeline as default
      const [inserted] = await tx
        .insert(schema.pipeline)
        .values({
          orgId,
          project: project.toLowerCase(),
          organization: organization.toLowerCase(),
          props: props as unknown as BuilderProps,
          accessModifier: accessModifier as any,
          isDefault: true,
          isActive: true,
          createdBy: ctx.identity.userId || 'system',
        })
        .returning();

      ctx.log('INFO', 'New pipeline created', { id: inserted.id, orgId: inserted.orgId });
      return inserted;
    });

    ctx.log('COMPLETED', 'Pipeline configuration saved successfully', { id: result.id });

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
    const dbDetails = extractDbError(error);

    ctx.log('ERROR', 'Pipeline save failed', { message, ...dbDetails });
    ctx.log('ROLLBACK', 'Transaction rolled back');

    return res.status(500).json({
      error: 'Failed to save pipeline configuration',
      message,
      ...dbDetails,
    });
  }
});

/**
 * Start the server
 */
runServer(app, {
  name: 'Pipeline POST microservice',
  sseManager,
});
import {
  // Database
  db,
  schema,

  // API utilities
  createApp,
  runServer,
  authenticateToken,
  createRequestContext,
  buildPipelineConditions,
  parsePagination,

  // Types
  PipelineFilter,
  validatePipelineFilter,
} from '@mwashburn160/pipeline-lib';
import { and } from 'drizzle-orm';
import { Request, Response } from 'express';


/**
 * Initialize app with common middleware
 */
const { app, sseManager } = createApp();

/**
 * Query pipelines with filters (returns multiple results)
 * GET /?project=my-app&organization=my-org
 */
app.get('/', authenticateToken, async (req: Request, res: Response) => {
  const ctx = createRequestContext(req, res, sseManager);

  ctx.log('INFO', 'Pipeline list request received', { query: req.query });

  try {
    const filter = req.query as unknown as Partial<PipelineFilter>;

    // Validate orgId
    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        message: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    ctx.log('INFO', 'Identity validated', {
      orgId: ctx.identity.orgId,
      userId: ctx.identity.userId,
      accessModifier: filter.accessModifier || 'not specified (will return org + public)',
    });

    // Validate filter
    try {
      validatePipelineFilter(filter as PipelineFilter);
    } catch (validationError) {
      ctx.log('ERROR', 'Filter validation failed', { error: validationError });
      return res.status(400).json({
        message: validationError instanceof Error ? validationError.message : 'Invalid filter',
      });
    }

    const conditions = buildPipelineConditions(filter, ctx.identity.orgId);
    const { limit, offset } = parsePagination(filter);

    ctx.log('INFO', 'Executing database query', {
      filterCount: conditions.length,
      limit,
      offset,
      orgId: ctx.identity.orgId,
    });

    const results = await db
      .select()
      .from(schema.pipeline)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset);

    if (results.length === 0) {
      ctx.log('INFO', 'No pipelines found matching the criteria');
      return res.status(404).json({
        message: 'No pipelines found matching the criteria.',
        data: [],
        count: 0,
      });
    }

    ctx.log('COMPLETED', 'Successfully retrieved pipelines', {
      count: results.length,
      organizations: [...new Set(results.map(r => r.organization))],
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
    ctx.log('ERROR', 'Pipeline list query failed', { error: message });
    return res.status(500).json({ message });
  }
});

/**
 * Start the server
 */
runServer(app, {
  name: 'Pipeline List microservice',
  sseManager,
});
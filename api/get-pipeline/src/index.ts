import { and } from 'drizzle-orm';

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
  TypedRequest,

  // Types
  PipelineFilter,
  validatePipelineFilter,
} from '@mwashburn160/pipeline-lib';

/**
 * Initialize app with common middleware
 */
const { app, sseManager } = createApp();

/**
 * Query pipelines with filters
 * GET /?project=my-app&organization=my-org
 */
app.get('/', authenticateToken, async (req: TypedRequest<{}, Partial<PipelineFilter>>, res) => {
  const ctx = createRequestContext(req, res, sseManager);

  ctx.log('INFO', 'Pipeline query request received', { query: req.query });

  try {
    const filter = req.query;

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

    ctx.log('INFO', 'Executing database query', {
      filterCount: conditions.length,
      filters: filter,
      orgId: ctx.identity.orgId,
    });

    const [result] = await db
      .select()
      .from(schema.pipeline)
      .where(and(...conditions))
      .limit(1);

    if (!result) {
      ctx.log('INFO', 'No pipeline found matching the criteria');
      return res.status(404).json({ message: 'Pipeline not found.' });
    }

    ctx.log('COMPLETED', 'Successfully retrieved pipeline', { id: result.id });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred.';
    ctx.log('ERROR', 'Pipeline query failed', { error: message });
    return res.status(500).json({ message });
  }
});

/**
 * Get pipeline by ID
 * GET /:id
 */
app.get('/:id', authenticateToken, async (req: TypedRequest<{}, {}, { id: string }>, res) => {
  const ctx = createRequestContext(req, res, sseManager);
  const { id } = req.params;

  if (!id) {
    ctx.log('ERROR', 'Pipeline ID is missing');
    return res.status(400).json({ message: 'Pipeline ID is required.' });
  }

  ctx.log('INFO', 'Pipeline query request received', { id });

  try {
    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        message: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    const conditions = buildPipelineConditions({ id }, ctx.identity.orgId);

    ctx.log('INFO', 'Executing database query', { id, orgId: ctx.identity.orgId });

    const [result] = await db
      .select()
      .from(schema.pipeline)
      .where(and(...conditions));

    if (!result) {
      ctx.log('INFO', 'No pipeline found matching the criteria');
      return res.status(404).json({ message: 'Pipeline not found.' });
    }

    ctx.log('COMPLETED', 'Successfully retrieved pipeline', { id: result.id });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred.';
    ctx.log('ERROR', 'Pipeline query failed', { error: message });
    return res.status(500).json({ message });
  }
});

/**
 * Start the server
 */
runServer(app, {
  name: 'Pipeline GET microservice',
  sseManager,
});
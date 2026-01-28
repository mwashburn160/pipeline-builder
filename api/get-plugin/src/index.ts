import {
  // Database
  db,
  schema,

  // API utilities
  createApp,
  runServer,
  authenticateToken,
  createRequestContext,
  buildPluginConditions,

  // Types
  PluginFilter,
  validatePluginFilter,
} from '@mwashburn160/pipeline-lib';
import { and } from 'drizzle-orm';
import { Request, Response } from 'express';


/**
 * Initialize app with common middleware
 */
const { app, sseManager } = createApp();

/**
 * Query plugins with filters
 * GET /?name=nodejs-build&version=1.0.0
 */
app.get('/', authenticateToken, async (req: Request, res: Response) => {
  const ctx = createRequestContext(req, res, sseManager);

  ctx.log('INFO', 'Plugin query request received', { query: req.query });

  try {
    const filter = req.query as unknown as Partial<PluginFilter>;

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
      validatePluginFilter(filter as PluginFilter);
    } catch (validationError) {
      ctx.log('ERROR', 'Filter validation failed', { error: validationError });
      return res.status(400).json({
        message: validationError instanceof Error ? validationError.message : 'Invalid filter',
      });
    }

    const conditions = buildPluginConditions(filter, ctx.identity.orgId);

    ctx.log('INFO', 'Executing database query', {
      filterCount: conditions.length,
      filters: filter,
      orgId: ctx.identity.orgId,
    });

    const [result] = await db
      .select()
      .from(schema.plugin)
      .where(and(...conditions))
      .limit(1);

    if (!result) {
      ctx.log('INFO', 'No plugin found matching the criteria');
      return res.status(404).json({ message: 'Plugin not found.' });
    }

    ctx.log('COMPLETED', 'Successfully retrieved plugin', { id: result.id, name: result.name });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred.';
    ctx.log('ERROR', 'Plugin query failed', { error: message });
    return res.status(500).json({ message });
  }
});

/**
 * Get plugin by ID
 * GET /:id
 */
app.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  const ctx = createRequestContext(req, res, sseManager);
  const { id } = req.params;

  if (!id) {
    ctx.log('ERROR', 'Plugin ID is missing');
    return res.status(400).json({ message: 'Plugin ID is required.' });
  }

  ctx.log('INFO', 'Plugin query request received', { id });

  try {
    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        message: 'Organization ID is required. Please provide x-org-id header.',
      });
    }

    const conditions = buildPluginConditions({ id }, ctx.identity.orgId);

    ctx.log('INFO', 'Executing database query', { id, orgId: ctx.identity.orgId });

    const [result] = await db
      .select()
      .from(schema.plugin)
      .where(and(...conditions));

    if (!result) {
      ctx.log('INFO', 'No plugin found matching the criteria');
      return res.status(404).json({ message: 'Plugin not found.' });
    }

    ctx.log('COMPLETED', 'Successfully retrieved plugin', { id: result.id, name: result.name });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred.';
    ctx.log('ERROR', 'Plugin query failed', { error: message });
    return res.status(500).json({ message });
  }
});

/**
 * Start the server
 */
runServer(app, {
  name: 'Plugin GET microservice',
  sseManager,
});
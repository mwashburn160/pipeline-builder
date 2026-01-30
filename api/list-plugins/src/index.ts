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
  parsePagination,

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
 * Query plugins with filters (returns multiple results)
 * GET /?name=nodejs&isActive=true
 */
app.get('/', authenticateToken, async (req: Request, res: Response) => {
  const ctx = createRequestContext(req, res, sseManager);

  ctx.log('INFO', 'Plugin list request received', { query: req.query });

  try {
    const filter = req.query as unknown as Partial<PluginFilter>;

    // Validate orgId
    if (!ctx.identity.orgId) {
      ctx.log('ERROR', 'Organization ID is missing from request headers');
      return res.status(400).json({
        success: false,
        statusCode: 400,
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
        success: false,
        statusCode: 400,
        message: validationError instanceof Error ? validationError.message : 'Invalid filter',
      });
    }

    const conditions = buildPluginConditions(filter, ctx.identity.orgId);
    const { limit, offset } = parsePagination(filter);

    ctx.log('INFO', 'Executing database query', {
      filterCount: conditions.length,
      limit,
      offset,
      orgId: ctx.identity.orgId,
    });

    const results = await db
      .select()
      .from(schema.plugin)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset);

    ctx.log('COMPLETED', 'Successfully retrieved plugins', {
      count: results.length,
      orgIds: [...new Set(results.map(r => r.orgId))],
    });

    return res.status(200).json({
      success: true,
      statusCode: 200,
      plugins: results,
      total: results.length,
      page: Math.floor(offset / limit) + 1,
      limit,
      hasMore: results.length === limit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred.';
    ctx.log('ERROR', 'Plugin list query failed', { error: message });
    return res.status(500).json({ success: false, statusCode: 500, message });
  }
});

/**
 * Start the server
 */
runServer(app, {
  name: 'Plugin List microservice',
  sseManager,
});
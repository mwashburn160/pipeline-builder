import { Router } from 'express';
import {
  listPipelines,
  getPipelineById,
  getPipeline,
  createPipeline,
} from '../controllers';
import {
  isAuthenticated,
  quotaCreatePipeline,
  quotaGetPipeline,
  apiRateLimiters,
} from '../middleware';

const router = Router();

/**
 * List pipelines
 * GET /pipeline
 * Query params: project, organization, pipelineName, isActive, isDefault, accessModifier, page, limit
 */
router.get('/', isAuthenticated, apiRateLimiters.read, listPipelines);

/**
 * Search for a single pipeline by filters
 * GET /pipeline/search
 * Query params: id, project, organization, pipelineName, isActive, isDefault, accessModifier
 */
router.get('/search', isAuthenticated, apiRateLimiters.search, getPipeline);

/**
 * Get pipeline by ID
 * GET /pipeline/:id
 */
router.get('/:id', isAuthenticated, apiRateLimiters.read, quotaGetPipeline, getPipelineById);

/**
 * Create a new pipeline configuration
 * POST /pipeline
 * Body: { project, organization, props, accessModifier? }
 */
router.post('/', isAuthenticated, apiRateLimiters.write, quotaCreatePipeline, createPipeline);

export default router;

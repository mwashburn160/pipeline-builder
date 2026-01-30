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
} from '../middleware';

const router = Router();

/**
 * List pipelines
 * GET /pipeline
 * Query params: project, organization, pipelineName, isActive, isDefault, accessModifier, page, limit
 */
router.get('/', isAuthenticated, listPipelines);

/**
 * Search for a single pipeline by filters
 * GET /pipeline/search
 * Query params: id, project, organization, pipelineName, isActive, isDefault, accessModifier
 */
router.get('/search', isAuthenticated, getPipeline);

/**
 * Get pipeline by ID
 * GET /pipeline/:id
 */
router.get('/:id', isAuthenticated, quotaGetPipeline, getPipelineById);

/**
 * Create a new pipeline configuration
 * POST /pipeline
 * Body: { project, organization, props, accessModifier? }
 */
router.post('/', isAuthenticated, quotaCreatePipeline, createPipeline);

export default router;

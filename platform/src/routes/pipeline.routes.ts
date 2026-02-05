/**
 * @module routes/pipeline
 * @description Pipeline management routes. Proxies requests to the pipeline microservices.
 * Quota enforcement is handled by the API microservices.
 */

import { Router } from 'express';
import {
  listPipelines,
  getPipelineById,
  getPipeline,
  createPipeline,
} from '../controllers';
import { isAuthenticated } from '../middleware';

const router = Router();

/**
 * @route GET /pipeline
 * @description List pipelines with optional filtering and pagination.
 * @query {string} [project] - Filter by project name
 * @query {string} [organization] - Filter by organization name
 * @query {string} [pipelineName] - Filter by pipeline name
 * @query {boolean} [isActive] - Filter by active status
 * @query {boolean} [isDefault] - Filter by default status
 * @query {string} [accessModifier] - Filter by 'public' or 'private'
 * @query {number} [page=1] - Page number
 * @query {number} [limit=20] - Results per page
 */
router.get('/', isAuthenticated, listPipelines);

/**
 * @route GET /pipeline/search
 * @description Search for a single pipeline matching filter criteria.
 * @query {string} [id] - Pipeline ID
 * @query {string} [project] - Project name
 * @query {string} [organization] - Organization name
 * @query {string} [pipelineName] - Pipeline name
 * @query {boolean} [isActive] - Active status
 * @query {boolean} [isDefault] - Default status
 * @query {string} [accessModifier] - 'public' or 'private'
 */
router.get('/search', isAuthenticated, getPipeline);

/**
 * @route GET /pipeline/:id
 * @description Get a pipeline by its unique ID.
 * @param {string} id - Pipeline UUID
 * @note Quota enforcement handled by get-pipeline microservice
 */
router.get('/:id', isAuthenticated, getPipelineById);

/**
 * @route POST /pipeline
 * @description Create a new pipeline configuration.
 * @consumes application/json
 * @body {string} project - Project name
 * @body {string} organization - Organization name
 * @body {Object} props - Pipeline builder configuration
 * @body {string} [accessModifier='private'] - 'public' or 'private'
 * @note Quota enforcement handled by create-pipeline microservice
 */
router.post('/', isAuthenticated, createPipeline);

export default router;

/**
 * @module routes/plugin
 * @description Plugin management routes. Proxies requests to the plugin microservices.
 * Quota enforcement is handled by the API microservices.
 */

import { Router } from 'express';
import multer from 'multer';
import {
  listPlugins,
  getPluginById,
  getPlugin,
  createPlugin,
} from '../controllers';
import { isAuthenticated } from '../middleware';

const router = Router();

/**
 * Multer configuration for plugin uploads.
 * Files are stored in memory for forwarding to the upload service.
 * Only ZIP files are accepted, max size 100MB.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 100 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});

/**
 * @route GET /plugin
 * @description List plugins with optional filtering and pagination.
 * @query {string} [name] - Filter by plugin name
 * @query {string} [version] - Filter by version
 * @query {string} [pluginType] - Filter by plugin type
 * @query {string} [computeType] - Filter by compute type
 * @query {boolean} [isActive] - Filter by active status
 * @query {boolean} [isDefault] - Filter by default status
 * @query {string} [accessModifier] - Filter by 'public' or 'private'
 * @query {number} [page=1] - Page number
 * @query {number} [limit=20] - Results per page
 */
router.get('/', isAuthenticated, listPlugins);

/**
 * @route GET /plugin/search
 * @description Search for a single plugin matching filter criteria.
 * @query {string} [id] - Plugin ID
 * @query {string} [name] - Plugin name
 * @query {string} [version] - Plugin version
 * @query {string} [pluginType] - Plugin type
 * @query {string} [computeType] - Compute type
 * @query {boolean} [isActive] - Active status
 * @query {boolean} [isDefault] - Default status
 * @query {string} [accessModifier] - 'public' or 'private'
 */
router.get('/search', isAuthenticated, getPlugin);

/**
 * @route GET /plugin/:id
 * @description Get a plugin by its unique ID.
 * @param {string} id - Plugin UUID
 * @note Quota enforcement handled by get-plugin microservice
 */
router.get('/:id', isAuthenticated, getPluginById);

/**
 * @route POST /plugin
 * @description Upload and create a new plugin.
 * @consumes multipart/form-data
 * @body {File} plugin - ZIP archive containing plugin files
 * @body {string} [accessModifier='private'] - 'public' or 'private'
 * @note Quota enforcement handled by upload-plugin microservice
 */
router.post('/', isAuthenticated, upload.single('plugin'), createPlugin);

export default router;

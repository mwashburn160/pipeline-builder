import { Router } from 'express';
import multer from 'multer';
import {
  listPlugins,
  getPluginById,
  getPlugin,
  createPlugin,
} from '../controllers';
import {
  isAuthenticated,
  quotaCreatePlugin,
  quotaGetPlugin,
  orgQuotaPlugins,
} from '../middleware';

const router = Router();

/**
 * Multer configuration for plugin file uploads
 * Store in memory for forwarding to upload service
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 100 * 1024 * 1024, // 100MB max
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
 * List plugins
 * GET /plugin
 * Query params: name, version, pluginType, computeType, isActive, isDefault, accessModifier, page, limit
 */
router.get('/', isAuthenticated, listPlugins);

/**
 * Search for a single plugin by filters
 * GET /plugin/search
 * Query params: id, name, version, pluginType, computeType, isActive, isDefault, accessModifier
 */
router.get('/search', isAuthenticated, getPlugin);

/**
 * Get plugin by ID
 * GET /plugin/:id
 */
router.get('/:id', isAuthenticated, quotaGetPlugin, getPluginById);

/**
 * Upload and create a new plugin
 * POST /plugin
 * Body: multipart/form-data with 'plugin' file and optional 'accessModifier'
 * Checks both rate limit (quotaCreatePlugin) and organization quota (orgQuotaPlugins)
 */
router.post('/', isAuthenticated, quotaCreatePlugin, orgQuotaPlugins, upload.single('plugin'), createPlugin);

export default router;

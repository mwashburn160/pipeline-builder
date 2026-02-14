/**
 * @module routes/log
 * @description Log query routes. Proxies Loki queries with org-scoped access control.
 */

import { Router } from 'express';
import { queryLogs, getLogServices, getLogLevels } from '../controllers';
import { isAuthenticated } from '../middleware';

const router = Router();

/**
 * @route GET /logs
 * @description Query logs with automatic org-scoped filtering.
 * Regular users see only their org's logs. System admins can query any org.
 * @query {string} [service] - Filter by service name
 * @query {string} [level] - Filter by log level
 * @query {string} [search] - Free-text search
 * @query {string} [orgId] - Org filter (system admins only)
 * @query {string} [start] - Start time (ISO 8601 or epoch ms)
 * @query {string} [end] - End time (ISO 8601 or epoch ms)
 * @query {number} [limit=100] - Max entries (1-1000)
 * @query {string} [direction=backward] - Sort direction
 */
router.get('/', isAuthenticated, queryLogs);

/**
 * @route GET /logs/services
 * @description List available service names from Loki.
 */
router.get('/services', isAuthenticated, getLogServices);

/**
 * @route GET /logs/levels
 * @description List available log levels from Loki.
 */
router.get('/levels', isAuthenticated, getLogLevels);

export default router;

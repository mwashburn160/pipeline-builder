/**
 * @module @mwashburn160/api-server
 * @description Express server infrastructure for API microservices.
 *
 * This package provides:
 * - App factory with middleware (CORS, Helmet, rate limiting)
 * - Server lifecycle management with graceful shutdown
 * - SSE connection manager
 * - Quota service client
 * - Authentication middleware (JWT)
 * - Request context creation
 */

// API Infrastructure
export * from './api';

// HTTP Utilities
export * from './http';
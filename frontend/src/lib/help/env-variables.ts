import { FileCode } from 'lucide-react';
import type { HelpTopic } from './types';

export const envVariablesTopic: HelpTopic = {
  id: 'env-variables',
  title: 'Environment Variables',
  description: 'Configuration reference for all services',
  icon: FileCode,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'All services are configured via environment variables. Copy deploy/local/.env.example to .env and fill in secret values. Never commit .env to version control.',
        },
        {
          type: 'warning',
          content: 'Generate JWT secrets with: openssl rand -base64 32',
        },
      ],
    },
    {
      id: 'jwt',
      title: 'JWT Authentication (Required)',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['JWT_SECRET', '—', 'Required. Secret for signing/verifying JWTs'],
            ['JWT_EXPIRES_IN', '86400', 'Token expiration in seconds (24h)'],
            ['JWT_ALGORITHM', 'HS256', 'Signing algorithm: HS256, HS384, HS512, RS256'],
            ['JWT_SALT_ROUNDS', '12', 'bcrypt salt rounds (10-12 recommended)'],
            ['REFRESH_TOKEN_SECRET', '—', 'Required. Separate secret for refresh tokens'],
            ['REFRESH_TOKEN_EXPIRES_IN', '2592000', 'Refresh token expiration in seconds (30d)'],
          ],
        },
      ],
    },
    {
      id: 'platform',
      title: 'Platform',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['PLATFORM_BASE_URL', 'https://localhost:8443', 'API gateway URL used by services and CLI'],
            ['PLATFORM_FRONTEND_URL', 'https://localhost:8443', 'Frontend URL for email links, OAuth redirects'],
            ['PORT', '3000', 'Service listen port'],
            ['TRUST_PROXY', '1', 'Trust proxy headers (set to 1 behind nginx/ALB)'],
          ],
        },
      ],
    },
    {
      id: 'database',
      title: 'PostgreSQL',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['POSTGRES_USER', 'postgres', 'PostgreSQL superuser'],
            ['POSTGRES_PASSWORD', '—', 'PostgreSQL superuser password'],
            ['POSTGRES_DB', 'pipeline_builder', 'Database name'],
            ['DB_HOST', 'postgres', 'Database host for services'],
            ['DB_PORT', '5432', 'Database port'],
            ['DB_USER', 'postgres', 'Database user for services'],
            ['DB_PASSWORD', '—', 'Database password for services'],
            ['DRIZZLE_MAX_POOL_SIZE', '20', 'Connection pool size'],
          ],
        },
      ],
    },
    {
      id: 'mongodb',
      title: 'MongoDB',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['MONGO_INITDB_ROOT_USERNAME', 'mongo', 'MongoDB root username'],
            ['MONGO_INITDB_ROOT_PASSWORD', '—', 'MongoDB root password'],
            ['MONGO_INITDB_DATABASE', 'platform', 'Initial database'],
            ['MONGODB_URI', '—', 'Full connection URI with replica set'],
          ],
        },
      ],
    },
    {
      id: 'logging',
      title: 'Logging',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['LOG_LEVEL', 'info', 'Log level: error, warn, info, debug'],
            ['LOG_FORMAT', 'json', 'Log format: json (structured) or text (human-readable)'],
            ['SERVICE_NAME', 'api', 'Service name in log output'],
          ],
        },
      ],
    },
    {
      id: 'quotas',
      title: 'Quotas',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['QUOTA_DEFAULT_PLUGINS', '100', 'Max plugins per org'],
            ['QUOTA_DEFAULT_PIPELINES', '10', 'Max pipelines per org'],
            ['QUOTA_DEFAULT_API_CALLS', '-1', 'Max API calls per org (-1 = unlimited)'],
            ['QUOTA_RESET_DAYS', '3', 'Quota reset period in days'],
            ['QUOTA_SERVICE_HOST', 'quota', 'Quota service hostname'],
            ['QUOTA_SERVICE_PORT', '3000', 'Quota service port'],
          ],
        },
      ],
    },
    {
      id: 'rate-limiting',
      title: 'Rate Limiting',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['LIMITER_MAX', '100', 'Max requests per window (global)'],
            ['LIMITER_WINDOWMS', '900000', 'Window in ms (15 min)'],
            ['RATE_LIMIT_WINDOW_MS', '60000', 'Quota service rate limit window'],
            ['RATE_LIMIT_MAX', '100', 'Quota service max requests per window'],
          ],
        },
      ],
    },
    {
      id: 'security',
      title: 'Security',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['MIN_PASSWORD_LENGTH', '12', 'Minimum password length'],
            ['MAX_LOGIN_ATTEMPTS', '5', 'Max login attempts before account lockout'],
            ['CORS_CREDENTIALS', 'true', 'Allow credentials in CORS requests'],
            ['CORS_ORIGIN', '(empty)', 'Allowed origins (comma-separated)'],
          ],
        },
      ],
    },
    {
      id: 'ai-providers',
      title: 'AI Providers',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Description'],
          rows: [
            ['ANTHROPIC_API_KEY', 'Anthropic API key'],
            ['OPENAI_API_KEY', 'OpenAI API key'],
            ['GOOGLE_GENERATIVE_AI_API_KEY', 'Google AI API key'],
            ['XAI_API_KEY', 'xAI (Grok) API key'],
            ['OLLAMA_BASE_URL', 'Ollama base URL (default: http://ollama:11434/v1)'],
          ],
        },
      ],
    },
    {
      id: 'billing',
      title: 'Billing',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['BILLING_ENABLED', 'false', 'Enable/disable billing service'],
            ['BILLING_PROVIDER', 'stub', 'Provider: stub (local dev) or aws-marketplace'],
            ['BILLING_SERVICE_HOST', 'billing', 'Billing service hostname'],
            ['BILLING_SERVICE_PORT', '3000', 'Billing service port'],
          ],
        },
      ],
    },
    {
      id: 'docker-registry',
      title: 'Docker Registry',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['IMAGE_REGISTRY_HOST', 'registry', 'Registry hostname'],
            ['IMAGE_REGISTRY_PORT', '5000', 'Registry port'],
            ['IMAGE_REGISTRY_USER', 'admin', 'Registry username'],
            ['IMAGE_REGISTRY_TOKEN', '—', 'Registry password/token'],
            ['DOCKER_BUILD_TIMEOUT_MS', '900000', 'Docker build timeout (15 min)'],
            ['PLUGIN_BUILD_CONCURRENCY', '1', 'Max concurrent Docker builds'],
          ],
        },
      ],
    },
    {
      id: 'email',
      title: 'Email',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['EMAIL_ENABLED', 'false', 'Enable/disable email sending'],
            ['EMAIL_FROM', 'noreply@example.com', 'Sender email address'],
            ['EMAIL_PROVIDER', 'smtp', 'Provider: smtp or ses'],
            ['SMTP_HOST', 'localhost', 'SMTP server host'],
            ['SMTP_PORT', '587', 'SMTP server port'],
          ],
        },
      ],
    },
    {
      id: 'google-oauth',
      title: 'Google OAuth (Optional)',
      blocks: [
        {
          type: 'table',
          headers: ['Variable', 'Default', 'Description'],
          rows: [
            ['OAUTH_GOOGLE_CLIENT_ID', '—', 'Google OAuth Client ID (empty = disabled)'],
            ['OAUTH_GOOGLE_CLIENT_SECRET', '—', 'Google OAuth Client Secret'],
            ['OAUTH_CALLBACK_BASE_URL', '${PLATFORM_FRONTEND_URL}', 'OAuth redirect origin'],
          ],
        },
      ],
    },
  ],
};

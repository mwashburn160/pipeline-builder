import { createHash } from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SQSEvent, SQSRecord } from 'aws-lambda';

/**
 * Pipeline event ingestion Lambda handler.
 *
 * Receives CodePipeline/CodeBuild events from SQS (sourced by EventBridge),
 * parses them into a normalized format, and POSTs them to the reporting service
 * via PLATFORM_BASE_URL.
 *
 * Authentication uses service credentials from Secrets Manager
 * at `pipeline-builder/plugin-lookup/credentials` (same secret as plugin-lookup).
 *
 * Environment variables:
 * - PLATFORM_BASE_URL — Base URL of the platform (e.g. https://app.example.com)
 */

const SECRETS_PATH_PREFIX = process.env.SECRETS_PATH_PREFIX || 'pipeline-builder';
const CREDENTIALS_SECRET_NAME = `${SECRETS_PATH_PREFIX}/plugin-lookup/credentials`;

/**
 * One-way SHA-256 hash of a sensitive identifier.
 * Must match the same algorithm used in api-core/mask-helpers.ts so that
 * the hashed ARN from the Lambda matches the hashed ARN in pipeline_registry.
 */
function hashId(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** Replace the account segment of an ARN with its SHA-256 hash. */
function hashAccountInArn(arn: string): string {
  const parts = arn.split(':');
  if (parts.length < 5 || !parts[4]) return arn;
  parts[4] = hashId(parts[4]);
  return parts.join(':');
}

const log = {
  info: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'INFO', message: msg, data, ts: new Date().toISOString() })),
  warn: (msg: string, data?: unknown) => console.log(JSON.stringify({ level: 'WARN', message: msg, data, ts: new Date().toISOString() })),
  error: (msg: string, data?: unknown) => console.error(JSON.stringify({ level: 'ERROR', message: msg, data, ts: new Date().toISOString() })),
};

// ─── Auth ───────────────────────────────────────────────

let cachedToken: { jwt: string; expiresAt: number } | null = null;
let cachedCredentials: { email: string; password: string } | null = null;

async function getCredentials(): Promise<{ email: string; password: string }> {
  if (cachedCredentials) return cachedCredentials;

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: CREDENTIALS_SECRET_NAME }));

  if (!response.SecretString) throw new Error(`Credentials secret "${CREDENTIALS_SECRET_NAME}" is empty`);

  const parsed = JSON.parse(response.SecretString) as { email?: string; password?: string };
  if (!parsed.email || !parsed.password) throw new Error('Credentials secret missing email or password');

  cachedCredentials = { email: parsed.email, password: parsed.password };
  return cachedCredentials;
}

async function getAuthToken(baseUrl: string): Promise<string> {
  // Reuse token if it has at least 60s remaining
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.jwt;
  }

  const { email, password } = await getCredentials();

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }),
  });

  const data = await res.json() as Record<string, unknown>;
  const tokenData = (data.data || data) as Record<string, unknown>;

  if (!res.ok || !tokenData.accessToken) {
    throw new Error(`Authentication failed: ${res.status} ${data.message || ''}`);
  }

  const jwt = tokenData.accessToken as string;
  const expiresIn = (tokenData.expiresIn as number) || 7200;
  cachedToken = { jwt, expiresAt: Date.now() + expiresIn * 1000 };

  log.info('Authenticated with platform API');
  return jwt;
}

// ─── Event Parsing ──────────────────────────────────────

interface ParsedEvent {
  pipelineArn: string;
  eventSource: string;
  eventType: string;
  status: string;
  executionId?: string;
  stageName?: string;
  actionName?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail: Record<string, unknown>;
}

function classifyEvent(detailType: string): { eventType: string; eventSource: string } {
  if (detailType.includes('Pipeline Execution')) return { eventType: 'PIPELINE', eventSource: 'codepipeline' };
  if (detailType.includes('Stage Execution')) return { eventType: 'STAGE', eventSource: 'codepipeline' };
  if (detailType.includes('Action Execution')) return { eventType: 'ACTION', eventSource: 'codepipeline' };
  if (detailType.includes('Build State')) return { eventType: 'BUILD', eventSource: 'codebuild' };
  return { eventType: 'PIPELINE', eventSource: 'codepipeline' };
}

function parseRecord(record: SQSRecord): ParsedEvent {
  const event = JSON.parse(record.body) as {
    'detail-type': string;
    'source': string;
    'detail': Record<string, unknown>;
    'time': string;
    'region': string;
    'account': string;
  };

  const detail = { ...event.detail };
  const pipelineName = detail.pipeline as string;

  // Hash account in ARN so the real account never reaches the database.
  // Must use the same hashId algorithm as api-core so registry lookups match.
  const pipelineArn = hashAccountInArn(
    `arn:aws:codepipeline:${event.region}:${event.account}:${pipelineName}`,
  );

  // Hash account in detail too
  if (event.account) {
    detail.account = hashId(event.account);
  }

  const { eventType, eventSource } = classifyEvent(event['detail-type']);
  const startedAt = (detail['start-time'] as string) || event.time;
  const state = detail.state as string;

  let durationMs: number | undefined;
  let completedAt: string | undefined;

  if (['SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED'].includes(state)) {
    completedAt = event.time;
    if (startedAt && completedAt) {
      const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
      if (ms >= 0) durationMs = ms;
    }
  }

  return {
    pipelineArn,
    eventSource,
    eventType,
    status: state,
    executionId: detail['execution-id'] as string | undefined,
    stageName: detail.stage as string | undefined,
    actionName: detail.action as string | undefined,
    startedAt,
    completedAt,
    durationMs,
    detail,
  };
}

// ─── Handler ────────────────────────────────────────────

export const handler = async (event: SQSEvent): Promise<void> => {
  const baseUrl = process.env.PLATFORM_BASE_URL;
  if (!baseUrl) throw new Error('PLATFORM_BASE_URL environment variable is required');

  // Parse all events
  const events = event.Records.map(parseRecord);

  // Authenticate
  const token = await getAuthToken(baseUrl);

  // POST batch to reporting service
  const res = await fetch(`${baseUrl}/api/reports/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ events }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.error(`Reporting API returned ${res.status}`, { body });
    throw new Error(`Reporting API failed: ${res.status}`);
  }

  const result = await res.json() as Record<string, unknown>;
  log.info(`Ingested ${events.length} events`, { inserted: result.data });
};

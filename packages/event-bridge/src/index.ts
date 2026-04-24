// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * Authentication:
 * - PLATFORM_TOKEN env var (preferred — no Secrets Manager call)
 * - PLATFORM_SECRET_NAME env var → reads accessToken from Secrets Manager
 *
 * Environment variables:
 * - PLATFORM_BASE_URL — Base URL of the platform
 * - PLATFORM_TOKEN — JWT token (set directly, or)
 * - PLATFORM_SECRET_NAME — Secrets Manager secret containing { accessToken }
 */

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

let cachedToken: string | null = null;

async function getAuthToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  // Path 1: PLATFORM_TOKEN env var (no Secrets Manager call)
  if (process.env.PLATFORM_TOKEN) {
    cachedToken = process.env.PLATFORM_TOKEN;
    log.info('Using PLATFORM_TOKEN from environment');
    return cachedToken;
  }

  // Path 2: PLATFORM_SECRET_NAME → read from Secrets Manager
  const secretName = process.env.PLATFORM_SECRET_NAME;
  if (!secretName) {
    throw new Error('PLATFORM_TOKEN or PLATFORM_SECRET_NAME environment variable is required');
  }

  log.info(`Fetching token from Secrets Manager: ${secretName}`);
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));

  if (!response.SecretString) throw new Error(`Secret "${secretName}" is empty`);

  const secret = JSON.parse(response.SecretString) as Record<string, string>;
  if (!secret.accessToken) {
    throw new Error('Secret missing accessToken — run "pipeline-manager store-token" to generate');
  }

  cachedToken = secret.accessToken;
  log.info('Using stored JWT token from Secrets Manager');
  return cachedToken;
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
  const token = await getAuthToken();

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

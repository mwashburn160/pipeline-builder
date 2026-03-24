#!/usr/bin/env node

import { PipelineBuilder, BuilderProps } from '@mwashburn160/pipeline-core';
import { App, Stack } from 'aws-cdk-lib';
import axios from 'axios';
import pico from 'picocolors';

const { cyan, green, dim, bold, magenta, red } = pico;

const REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'pipeline-manager/boilerplate',
};

const app = new App();

/**
 * Parse PIPELINE_PROPS from environment (CLI deploy path).
 */
function parseFromEnv(): BuilderProps {
  const encodedProps = process.env.PIPELINE_PROPS;
  if (!encodedProps) {
    throw new Error('PIPELINE_PROPS environment variable is missing.');
  }

  try {
    const decoded = Buffer.from(encodedProps, 'base64').toString('utf-8');
    return JSON.parse(decoded) as BuilderProps;
  } catch (error) {
    throw new Error(
      `Failed to parse PIPELINE_PROPS: ${error instanceof Error ? error.message : 'Invalid Base64/JSON format'}`,
    );
  }
}

/**
 * Fetch pipeline config from the platform API (autonomous CodePipeline path).
 *
 * Requires environment variables:
 * - PIPELINE_ID — database record ID
 * - PLATFORM_BASE_URL — platform API endpoint
 * - PLATFORM_CREDENTIALS — JSON string with { email, password } (injected from Secrets Manager)
 */
async function fetchFromPlatform(): Promise<BuilderProps> {
  const pipelineId = process.env.PIPELINE_ID;
  const baseUrl = process.env.PLATFORM_BASE_URL;
  const credentialsJson = process.env.PLATFORM_CREDENTIALS;

  if (!pipelineId || !baseUrl || !credentialsJson) {
    const missing = [
      !pipelineId && 'PIPELINE_ID',
      !baseUrl && 'PLATFORM_BASE_URL',
      !credentialsJson && 'PLATFORM_CREDENTIALS',
    ].filter(Boolean).join(', ');
    throw new Error(
      `Cannot fetch pipeline config autonomously — missing: ${missing}. ` +
      'Either set PIPELINE_PROPS (CLI deploy) or ensure PIPELINE_ID, PLATFORM_BASE_URL, and PLATFORM_CREDENTIALS are available.',
    );
  }

  // Parse credentials (injected from Secrets Manager as JSON string)
  let email: string;
  let password: string;
  try {
    const creds = JSON.parse(credentialsJson);
    email = creds.email;
    password = creds.password;
    if (!email || !password) throw new Error('missing email or password fields');
  } catch (error) {
    throw new Error(
      `Failed to parse PLATFORM_CREDENTIALS: ${error instanceof Error ? error.message : 'Invalid JSON'}`,
    );
  }

  console.log(cyan('Authenticating with platform...'));
  const { data: authData } = await axios.post(`${baseUrl}/api/auth/login`, {
    email,
    password,
  }, {
    timeout: 15000,
    headers: REQUEST_HEADERS,
  });

  const token = authData?.data?.accessToken || authData?.token;
  if (!token) {
    throw new Error('Authentication failed — no token in response');
  }

  console.log(cyan(`Fetching pipeline config for ID: ${pipelineId}`));
  const { data: pipelineData } = await axios.get(`${baseUrl}/api/pipeline/${pipelineId}`, {
    timeout: 15000,
    headers: {
      ...REQUEST_HEADERS,
      Authorization: `Bearer ${token}`,
    },
  });

  // Extract props from response — handles { data: { pipeline: { props } } } or { pipeline: { props } }
  const pipeline = pipelineData?.data?.pipeline || pipelineData?.pipeline;
  if (!pipeline?.props) {
    throw new Error(`Pipeline ${pipelineId} has no props — response: ${JSON.stringify(pipelineData).slice(0, 200)}`);
  }

  console.log(green('Pipeline config fetched successfully'));

  // Inject pipelineId and orgId for downstream use
  return {
    ...pipeline.props,
    ...(pipeline.orgId && { orgId: pipeline.orgId }),
    pipelineId: pipeline.id,
  } as BuilderProps;
}

/**
 * Resolve BuilderProps: prefer PIPELINE_PROPS (CLI), fall back to platform API fetch.
 */
async function resolveProps(): Promise<BuilderProps> {
  if (process.env.PIPELINE_PROPS) {
    return parseFromEnv();
  }
  return fetchFromPlatform();
}

async function main(): Promise<void> {
  const executionId = Math.random().toString(36).substring(7).toUpperCase();

  console.log(
    `${magenta(`[CDK-APP-${executionId}]`)} ${cyan('Pipeline builder starting')}`,
  );

  const props = await resolveProps();

  const stackName = `${props.project}-${props.organization}`.toLowerCase();
  const componentId = 'pipeline-builder';

  console.log('Pipeline configuration:', {
    stackName,
    project: props.project,
    organization: props.organization,
    componentId,
  });

  const stack = new Stack(app, stackName, {});
  new PipelineBuilder(stack, componentId, props);

  console.log(
    green(bold('Success')),
    green('CDK constructs synthesized successfully'),
  );
}

main().catch((error) => {
  console.error(
    bold(red('[BUILD FAILED]')),
    error instanceof Error ? error.message : String(error),
  );

  if (error instanceof Error && error.stack) {
    console.error(dim(error.stack));
  }

  process.exit(1);
});

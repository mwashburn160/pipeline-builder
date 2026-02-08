#!/usr/bin/env node

import { PipelineBuilder, BuilderProps } from '@mwashburn160/pipeline-core';
import { App, Stack } from 'aws-cdk-lib';
import pico from 'picocolors';

const { cyan, green, dim, bold, magenta, red } = pico;

const app = new App();

function parse(): BuilderProps {
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

function main(): void {
  const executionId = Math.random().toString(36).substring(7).toUpperCase();

  console.log(
    `${magenta(`[CDK-APP-${executionId}]`)} ${cyan('Pipeline builder starting')}`,
  );

  const props = parse();

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

try {
  main();
} catch (error) {
  console.error(
    bold(red('[BUILD FAILED]')),
    error instanceof Error ? error.message : String(error),
  );

  if (error instanceof Error && error.stack) {
    console.error(dim(error.stack));
  }

  process.exit(1);
}
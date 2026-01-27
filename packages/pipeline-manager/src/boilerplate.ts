#!/usr/bin/env node

import { Builder, BuilderProps } from '@mwashburn160/pipeline-lib';
import { App, Stack } from 'aws-cdk-lib';
import pico from 'picocolors';

const { cyan, green, yellow, dim, bold, magenta, red } = pico;

const app = new App();

function parse(): BuilderProps {
  const encodedProps = process.env.PIPELINE_PROPS;

  if (!encodedProps) {
    throw new Error('PIPELINE_PROPS environment variable is missing.');
  }

  try {
    const decoded = Buffer.from(encodedProps, 'base64').toString('utf-8');
    const rawProps = JSON.parse(decoded) as BuilderProps;

    const props: BuilderProps = {
      ...rawProps,
      project: rawProps.project.replace(/\s+/g, ''),
      organization: rawProps.organization.replace(/\s+/g, ''),
    };

    return props;
  } catch (error) {
    throw new Error(
      `Failed to parse PIPELINE_PROPS: ${error instanceof Error ? error.message : 'Invalid Base64/JSON format'}`,
    );
  }
}

function validate(props: BuilderProps): void {
  if (!props.project || !props.organization) {
    console.error(
      yellow(bold('[VALIDATION] Missing required fields')),
      { project: props.project, organization: props.organization },
    );
    throw new Error('Missing required properties: project and/or organization');
  }
}

function main(): void {
  const executionId = Math.random().toString(36).substring(7).toUpperCase();

  console.log(
    `${magenta(`[CDK-APP-${executionId}]`)} ${cyan('Pipeline builder starting')}`,
  );

  const props = parse();
  validate(props);

  const stackName = `${props.project}-${props.organization}`.toLowerCase();
  const componentId = 'pipeline-builder';

  console.log('Pipeline configuration:', {
    stackName,
    project: props.project,
    organization: props.organization,
    componentId,
  });

  const stack = new Stack(app, stackName, {});
  new Builder(stack, componentId, props);

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
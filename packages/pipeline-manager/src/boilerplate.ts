#!/usr/bin/env node
// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '@pipeline-builder/api-core';
import { STEP_MANIFEST_FILE } from '@pipeline-builder/pipeline-core';
import { PipelineBuilder, type BuilderProps } from '@pipeline-builder/pipeline-core/cdk';
import { App, Stack } from 'aws-cdk-lib';
import pico from 'picocolors';
import { generateExecutionId } from './config/cli.constants.js';
import { readPropsFile } from './utils/props-file.js';
import { synthStackName } from './utils/synth-stack-name.js';

const { cyan, green, dim, bold, magenta, red } = pico;

const app = new App();

function main(): void {
  const executionId = generateExecutionId().toUpperCase();

  console.log(
    `${magenta(`[CDK-APP-${executionId}]`)} ${cyan('Pipeline builder starting')}`,
  );

  const props = readPropsFile<BuilderProps>();

  const stackName = synthStackName(props as unknown as BuilderProps & Record<string, unknown>);
  const componentId = 'pipeline-builder';

  console.log('Pipeline configuration:', {
    stackName,
    project: props.project,
    organization: props.organization,
    componentId,
  });

  const stack = new Stack(app, stackName, {});
  const builder = new PipelineBuilder(stack, componentId, props);

  // Synthesize now (App.synth() is cached, so the CLI's own synth is a no-op)
  // and drop the step manifest next to the template: `deploy` reads it back
  // from `--output` and ships it with the registry registration.
  const assembly = app.synth();
  writeFileSync(join(assembly.directory, STEP_MANIFEST_FILE), JSON.stringify(builder.stepManifest));

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
    errorMessage(error),
  );

  if (error instanceof Error && error.stack) {
    console.error(dim(error.stack));
  }

  process.exit(1);
}

// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PipelineStackNotice for a LIVE pipeline states the same outcome the server's
 * purge will have: the stack is removed only through a deploy-capable runner
 * AND when its stack name and region are recorded (else `no_stack`).
 */

import { describe, it, expect } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import { DEPLOY_CAPABILITY } from '@pipeline-builder/api-core/pipeline-runners';
import { PipelineStackNotice } from '../src/components/pipeline/PipelineStackNotice';

const capable = { label: 'prod', capabilities: [DEPLOY_CAPABILITY] };

describe('PipelineStackNotice (live)', () => {
  it('a deploy-capable runner and a recorded stack: a purge asks the runner to delete it', () => {
    render(<PipelineStackNotice purge={false} source={{ kind: 'live', stackName: 'acme-app', region: 'us-east-1', runner: capable }} />);
    expect(screen.getByTestId('pipeline-stack-notice')).toHaveTextContent(/asks prod to delete the stack acme-app \(us-east-1\)/);
  });

  it('a deploy-capable runner but no recorded stack: the stack stays (no_stack), as the server will do', () => {
    render(<PipelineStackNotice purge={false} source={{ kind: 'live', stackName: null, region: null, runner: capable }} />);
    const notice = screen.getByTestId('pipeline-stack-notice');
    expect(notice).not.toHaveTextContent(/asks prod to delete/);
    expect(notice).toHaveTextContent(/no stack name and region recorded/);
  });

  it('a runner without deploys: the stack stays, and says why', () => {
    render(<PipelineStackNotice purge={false} source={{ kind: 'live', stackName: 'acme-app', region: 'us-east-1', runner: { label: 'prod', capabilities: [] } }} />);
    expect(screen.getByTestId('pipeline-stack-notice')).toHaveTextContent(/deploys are not enabled on it/);
  });
});
